const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');

test('hidden receiver launcher waits for Node, preserves exit status and previous diagnostics', { skip: process.platform !== 'win32' }, () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'remote print launcher '));
  try {
    fs.mkdirSync(path.join(directory, 'scripts'));
    const config = path.join(directory, 'agent.json');
    fs.writeFileSync(config, '{}');
    fs.writeFileSync(path.join(directory, 'scripts/remote-print-agent.cjs'), `
      const fs = require('node:fs');
      if (!fs.existsSync(process.argv[2])) process.exit(90);
      console.log('receiver fixture started');
      console.error('receiver fixture failure');
      setTimeout(() => process.exit(7), 150);
    `);
    const run = () => spawnSync('powershell.exe', ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-File', path.resolve('scripts/run-remote-print-agent.ps1'), '-ConfigFile', config, '-NodeExe', process.execPath], { windowsHide: true, encoding: 'utf8', timeout: 15000 });
    for (let i = 0; i < 2; i++) {
      const result = run();
      assert.equal(result.status, 7, result.stderr || result.error?.message);
      assert.match(fs.readFileSync(path.join(directory, 'receiver.log'), 'utf8'), /receiver fixture started/);
      assert.match(fs.readFileSync(path.join(directory, 'receiver-error.log'), 'utf8'), /receiver fixture failure/);
    }
    assert.equal(fs.readdirSync(directory).filter(name => name.startsWith('receiver.log.')).length, 1);
    assert.equal(fs.readdirSync(directory).filter(name => name.startsWith('receiver-error.log.')).length, 1);
    const lifecycle = fs.readFileSync(path.join(directory, 'supervisor.log'), 'utf8');
    assert.equal((lifecycle.match(/receiver exited: 7/g) || []).length, 2);
    assert.equal(fs.readFileSync(config, 'utf8'), '{}');
  } finally { fs.rmSync(directory, { recursive: true, force: true }); }
});
