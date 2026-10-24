'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { spawnSync } = require('node:child_process');

const publisherPath = path.resolve(__dirname, '../scripts/publish-backend.py');

function runPython(source) {
  const result = spawnSync(process.env.PYTHON || 'python', ['-c', source, publisherPath], {
    encoding: 'utf8',
    timeout: 10000
  });
  assert.equal(result.status, 0, result.stderr || result.stdout);
  return result.stdout.trim();
}

function importPublisherSource() {
  return [
    'import importlib.util,sys,types',
    // The production publisher targets Linux; stub only its advisory lock import
    // so the diagnostics helpers can be unit-tested on Windows.
    "sys.modules['fcntl']=types.SimpleNamespace(LOCK_EX=1,LOCK_UN=2,flock=lambda *args:None)",
    'spec=importlib.util.spec_from_file_location("publisher",sys.argv[1])',
    'publisher=importlib.util.module_from_spec(spec)',
    'spec.loader.exec_module(publisher)'
  ].join(';');
}

test('publisher failure diagnostics are enum-bounded and do not include exception text', () => {
  const output = runPython([
    importPublisherSource(),
    'import contextlib,io,json',
    "secret='private customer data and credential'",
    "records=[publisher.failure_record('service_properties',ValueError(secret)),publisher.failure_record('backup_create_staging',OSError(13,secret))]",
    'stream=io.StringIO()',
    "with contextlib.redirect_stderr(stream): publisher.emit_failure('service_properties',ValueError(secret))",
    "print(json.dumps({'records':records,'output':stream.getvalue()}))"
  ].join('\n'));
  const { records, output: marker } = JSON.parse(output);
  assert.deepEqual(records[0], {
    phase: 'service_properties',
    exception: 'ValueError',
    errno: null,
    reason: 'service_configuration_invalid',
    rollback: 'not_attempted'
  });
  assert.deepEqual(records[1], {
    phase: 'backup_create_staging',
    exception: 'OSError',
    errno: 13,
    reason: 'backup_failed',
    rollback: 'not_attempted'
  });
  assert.match(marker, /^BACKEND_PUBLISH_FAILURE \{"phase":"service_properties"/);
  assert.equal(marker.includes('private customer data and credential'), false);
});

test('publisher preserves rollback restart phase and captures originating failures before cleanup', () => {
  const output = runPython([
    importPublisherSource(),
    'import json',
    'from types import SimpleNamespace',
    "phases=[];publisher.begin_phase=phases.append",
    'publisher.os.geteuid=lambda:0',
    'publisher.subprocess.run=lambda *args,**kwargs:SimpleNamespace(returncode=0)',
    "publisher.restart_service('rollback_restart')",
    "print(json.dumps({'phases':phases}))"
  ].join('\n'));
  assert.deepEqual(JSON.parse(output), { phases: ['rollback_restart'] });

  const source = fs.readFileSync(publisherPath, 'utf8');
  const phaseCapture = source.indexOf("raise PublishFailure(_active_phase, exception, 'not_attempted')");
  const cleanupPhase = source.indexOf("begin_phase('cleanup')", phaseCapture);
  assert.ok(phaseCapture >= 0, 'unexpected pre-cleanup failures should preserve their original phase');
  assert.ok(cleanupPhase > phaseCapture, 'cleanup must not replace the captured failure phase');
  assert.match(source, /acceptance_result = healthcheck\(working, service_env\)\s+begin_phase\('write_acceptance'\)\s+acceptance\.write_text\(acceptance_result/);
});
