'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const crypto = require('node:crypto');
const { execFileSync, spawnSync } = require('node:child_process');

const uploader = require('../scripts/upload-backend.cjs');

const commit = 'a'.repeat(40);

function metadata(content) {
  const bytes = Buffer.from(content);
  return {
    size: bytes.length,
    sha256: crypto.createHash('sha256').update(bytes).digest('hex'),
    data: bytes.toString('base64')
  };
}

function createBundleFile(directory, bundleCommit = commit) {
  const files = {
    'server.js': metadata("'use strict';\n"),
    'db.js': metadata("'use strict';\n"),
    'team.js': metadata("'use strict';\n"),
    'daily-backup.js': metadata("'use strict';\n"),
    'product-image-backup.js': metadata("'use strict';\n"),
    'ledger-attachments.js': metadata("'use strict';\n"),
    'business-workflow.js': metadata("'use strict';\n"),
    'package.json': metadata(JSON.stringify({ name: 'shuguang-server', dependencies: { express: '^4.0.0' } })),
    'package-lock.json': metadata(JSON.stringify({ name: 'shuguang-server', lockfileVersion: 3 })),
    'node_modules/express/package.json': metadata(JSON.stringify({ name: 'express' }))
  };
  const bundle = {
    format: 'warehouse-backend-release-v1',
    commit: bundleCommit,
    files
  };
  const file = path.join(directory, 'backend-bundle.json');
  const sourceRoot = path.join(directory, 'source');
  for (const [name, entry] of Object.entries(files)) {
    if (name.startsWith('node_modules/')) continue;
    const target = path.join(sourceRoot, 'backend', ...name.split('/'));
    fs.mkdirSync(path.dirname(target), { recursive: true });
    fs.writeFileSync(target, Buffer.from(entry.data, 'base64'));
  }
  fs.writeFileSync(file, JSON.stringify(bundle));
  return { file, bundle, sourceRoot };
}

test('backend upload requires and verifies an explicit bundle tied to RELEASE_COMMIT', () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'warehouse-backend-upload-'));
  try {
    const valid = createBundleFile(directory);
    const result = uploader.validateLocalBundle(valid.file, commit, { sourceRoot: valid.sourceRoot, isTracked: () => true });
    assert.equal(result.commit, commit);
    assert.equal(result.sourceHashes['server.js'], valid.bundle.files['server.js'].sha256);
    assert.equal(Object.hasOwn(result.sourceHashes, 'node_modules/express/package.json'), false);
    assert.throws(() => uploader.validateLocalBundle('', commit), /BACKEND_LOCAL_BUNDLE/);
    assert.throws(() => uploader.validateLocalBundle(valid.file, 'latest', { sourceRoot: valid.sourceRoot, isTracked: () => true }), /full Git commit/);
    assert.throws(() => uploader.validateLocalBundle(valid.file, 'b'.repeat(40), { sourceRoot: valid.sourceRoot, isTracked: () => true }), /commit does not match/);

    const invalid = createBundleFile(directory, commit);
    invalid.bundle.files['server.js'].sha256 = 'f'.repeat(64);
    fs.writeFileSync(invalid.file, JSON.stringify(invalid.bundle));
    assert.throws(() => uploader.validateLocalBundle(invalid.file, commit, { sourceRoot: invalid.sourceRoot, isTracked: () => true }), /content mismatch/);
    fs.writeFileSync(valid.file, JSON.stringify(valid.bundle));

    assert.throws(() => uploader.validateLocalBundle(valid.file, commit, {
      sourceRoot: valid.sourceRoot,
      isTracked: (name, revision) => name !== 'backend/server.js' && revision === commit
    }), /not tracked by Git at/);
  } finally {
    fs.rmSync(directory, { recursive: true, force: true });
  }
});

test('bundle tracking validation uses the actual Git exit status', () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'warehouse-bundle-git-'));
  try {
    const fixture = createBundleFile(directory);
    const git = args => execFileSync('git', args, { cwd: fixture.sourceRoot, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });
    git(['init', '--quiet']);
    git(['-c', 'core.autocrlf=false', 'add', 'backend']);
    git(['-c', 'user.name=Release Test', '-c', 'user.email=release-test@example.invalid', '-c', 'commit.gpgsign=false', 'commit', '--quiet', '--no-verify', '-m', 'fixture']);
    const revision = git(['rev-parse', 'HEAD']).trim();
    fixture.bundle.commit = revision;
    fs.writeFileSync(fixture.file, JSON.stringify(fixture.bundle));
    const options = { sourceRoot: fixture.sourceRoot, cwd: fixture.sourceRoot };
    assert.equal(uploader.validateLocalBundle(fixture.file, revision, options).commit, revision);
    fixture.bundle.files['untracked-module.js'] = metadata("'use strict';\n");
    fs.writeFileSync(path.join(fixture.sourceRoot, 'backend/untracked-module.js'), "'use strict';\n");
    fs.writeFileSync(fixture.file, JSON.stringify(fixture.bundle));
    assert.throws(() => uploader.validateLocalBundle(fixture.file, revision, options), /not tracked by Git at/);
  } finally {
    fs.rmSync(directory, { recursive: true, force: true });
  }
});

test('backend release provenance requires clean source, HEAD, RELEASE_COMMIT and current origin/main', () => {
  const outputs = new Map([
    ['rev-parse HEAD', `${commit}\n`],
    ['status --porcelain=v1 --untracked-files=normal -- backend deploy/backend-release scripts/publish-backend.py scripts/verify-backend-release.js scripts/verify-backend-daily-status.js scripts/verify-backend-billing.cjs scripts/upload-backend.cjs :(exclude,glob)backend/public/uploads/**', ''],
    ['ls-remote origin refs/heads/main', `${commit}\trefs/heads/main\n`]
  ]);
  const runGit = args => {
    const key = args.join(' ');
    assert.ok(outputs.has(key), `unexpected git invocation: ${key}`);
    return outputs.get(key);
  };
  assert.deepEqual(uploader.validateProvenance(commit, { runGit }), { commit, latest: commit });

  assert.throws(() => uploader.validateProvenance('b'.repeat(40), { runGit }), /equal HEAD/);
  assert.throws(() => uploader.validateProvenance(commit, {
    runGit: args => args[0] === 'status' ? ' M backend/db.js\n' : runGit(args)
  }), /uncommitted changes/);
  assert.throws(() => uploader.validateProvenance(commit, {
    runGit: args => args[0] === 'ls-remote' ? `${'c'.repeat(40)}\trefs/heads/main\n` : runGit(args)
  }), /equal HEAD/);
});

test('remote release plan stages the bundle and required publisher verifier in one unique temp directory', () => {
  const plan = uploader.createRemotePlan('backend-bundle.json', commit, '12345678-1234-4234-9234-123456789abc');
  assert.equal(plan.stage, '/tmp/shuguang-backend-12345678-1234-4234-9234-123456789abc');
  assert.deepEqual(plan.remoteFiles, [
    `${plan.stage}/bundle.json`,
    `${plan.stage}/publish-backend.py`,
    `${plan.stage}/verify-backend-daily-status.js`,
    `${plan.stage}/verify-backend-billing.cjs`
  ]);
  assert.ok(plan.publish.includes(`RELEASE_COMMIT='${commit}'`));
  assert.match(plan.publish, /^if \[ "\$\(id -u\)" -eq 0 \]; then set --; else set -- sudo -n; fi; exec "\$@" env RELEASE_COMMIT=/);
  assert.match(plan.summary, /^if \[ "\$\(id -u\)" -eq 0 \]; then set --; else set -- sudo -n; fi; exec "\$@" python3 /);
  assert.ok(plan.publish.includes(uploader.BACKUP_ROOT));
  assert.ok(plan.publish.endsWith('--restart'));
  assert.ok(plan.acceptance.startsWith(`${plan.stage}/`));
  assert.match(plan.cleanup, /rm -f --/);
  assert.doesNotMatch(plan.cleanup, /rm -rf/);
  assert.throws(() => uploader.createRemotePlan('bundle.json', commit, 'not-a-uuid'), /staging id/);
  assert.throws(() => uploader.createRemotePlan('bundle.json', 'latest', '12345678-1234-4234-9234-123456789abc'), /full Git commit/);
});

test('remote acceptance and deployed hashes are verified before producing a redacted summary', () => {
  const expectedHashes = { 'db.js': '1'.repeat(64), 'server.js': '2'.repeat(64) };
  const result = {
    acceptance: {
      dailyStatus: { status: 200, verified: true, active: true },
      billing: { verified: true, productionReceivable: 500, collected: 100, finalDebt: 400, shipmentReceivable: 0, token: 'must-not-be-forwarded' }
    },
    hashes: { ...expectedHashes },
    service: { active: true, mainPid: 4321 }
  };
  const summary = uploader.validateRemoteSummary(JSON.stringify(result), expectedHashes);
  assert.equal(summary.acceptance.dailyStatus.status, 200);
  assert.equal(summary.acceptance.billing.finalDebt, 400);
  assert.deepEqual(summary.sourceHashes, expectedHashes);
  assert.equal(JSON.stringify(summary).includes('must-not-be-forwarded'), false);
  assert.throws(() => uploader.validateRemoteSummary(JSON.stringify({
    ...result,
    hashes: { ...expectedHashes, 'server.js': 'f'.repeat(64) }
  }), expectedHashes), /hash mismatch/);
  assert.throws(() => uploader.validateRemoteSummary(JSON.stringify({
    ...result,
    acceptance: { ...result.acceptance, dailyStatus: { status: 503 } }
  }), expectedHashes), /acceptance failed/);
  assert.throws(() => uploader.validateRemoteSummary(JSON.stringify({
    ...result,
    acceptance: { ...result.acceptance, billing: { ...result.acceptance.billing, finalDebt: 500 } }
  }), expectedHashes), /billing acceptance failed/);
  assert.throws(() => uploader.validateRemoteSummary(JSON.stringify({
    ...result,
    service: { active: false, mainPid: 0 }
  }), expectedHashes), /service is not active/);
});

test('password authentication passes only sanitized child environment and restores SSHPASS after scrubbing', () => {
  const secret = 'acceptance-password';
  let called = false;
  const result = uploader.withAuth((env, passwordMode) => {
    called = true;
    assert.equal(passwordMode, true);
    assert.equal(env.SSHPASS, secret);
    assert.equal(Object.hasOwn(env, 'HOTUPDATE_PASSWORD'), false);
    assert.equal(Object.hasOwn(env, 'SSH_PRIVATE_KEY'), false);
    return 'authenticated';
  }, { HOTUPDATE_PASSWORD: secret, SSHPASS: 'stale-password' });
  assert.equal(called, true);
  assert.equal(result, 'authenticated');
  const scrubbed = uploader.sanitizedChildEnv({ HOTUPDATE_PASSWORD: secret, SSH_PRIVATE_KEY: 'private-key', SSHPASS: 'stale-password' });
  assert.equal(Object.hasOwn(scrubbed, 'HOTUPDATE_PASSWORD'), false);
  assert.equal(Object.hasOwn(scrubbed, 'SSH_PRIVATE_KEY'), false);
  assert.equal(Object.hasOwn(scrubbed, 'SSHPASS'), false);
});

test('remote failures name the deployment phase and expose no credential or command output', () => {
  const password = 'acceptance-password-do-not-log';
  const privateKey = '-----BEGIN OPENSSH PRIVATE KEY-----\nprivate-key-material-do-not-log\n-----END OPENSSH PRIVATE KEY-----';
  const privateKeyLine = 'private-key-material-do-not-log';
  const businessData = 'customer=Private Customer, debt=12345';
  const failure = Object.assign(new Error(`remote command failed: ${password}\n${privateKey}`), {
    status: 255,
    code: 'ECONNRESET',
    signal: 'SIGTERM',
    stdout: Buffer.from(businessData),
    stderr: Buffer.from(`${password}\n${privateKey}\n${businessData}`)
  });
  let invocation;
  assert.throws(() => uploader.executeRemote(
    'publish backend revision and run acceptance',
    'ssh',
    ['-p', '22', 'deploy@example.invalid', 'remote command'],
    { cwd: '/workspace' },
    { SSHPASS: password },
    true,
    (executable, args, options) => {
      invocation = { executable, args, options };
      throw failure;
    }
  ), error => {
    assert.match(error.message, /publish backend revision and run acceptance/);
    assert.match(error.message, /exit=255/);
    assert.match(error.message, /code=ECONNRESET/);
    assert.match(error.message, /signal=SIGTERM/);
    for (const secret of [password, privateKey, privateKeyLine, businessData]) {
      assert.equal(error.message.includes(secret), false);
    }
    return true;
  });
  assert.equal(invocation.executable, 'sshpass');
  assert.deepEqual(invocation.args.slice(0, 2), ['-e', 'ssh']);
  assert.equal(invocation.options.env.SSHPASS, password);
  assert.equal(invocation.options.encoding, 'utf8');
});

test('remote failure diagnostics classify known publisher errors without exposing multiline output', () => {
  const password = 'secret-password-do-not-log';
  const privateKey = '-----BEGIN OPENSSH PRIVATE KEY-----\nsecret-key-material-do-not-log\n-----END OPENSSH PRIVATE KEY-----';
  const customerRecord = 'customer=Private Customer, debt=12345';
  const failure = Object.assign(new Error('remote command failed'), {
    status: 1,
    stderr: Buffer.from(`service must run as a non-root user\n${password}\n${privateKey}\n${customerRecord}`),
    stdout: Buffer.from(`${password}\n${customerRecord}`)
  });
  assert.throws(() => uploader.executeRemote(
    'publish backend revision and run acceptance', 'ssh', [], {}, {}, false,
    () => { throw failure; }
  ), error => {
    assert.match(error.message, /publish backend revision and run acceptance/);
    assert.match(error.message, /reason=service account must be non-root/);
    for (const secret of [password, privateKey, 'secret-key-material-do-not-log', customerRecord]) {
      assert.equal(error.message.includes(secret), false);
    }
    assert.equal(error.message.includes('service must run as a non-root user'), false);
    return true;
  });
});

test('invalid or malicious publisher markers are ignored and never echoed', () => {
  const privateKey = '-----BEGIN OPENSSH PRIVATE KEY-----\nmalicious-key-material\n-----END OPENSSH PRIVATE KEY-----';
  const customerData = 'customer=Alice, debt=800';
  const invalidMarkers = [
    { phase: `service_properties ${customerData}`, exception: 'ValueError', errno: 1, reason: 'permission_denied', rollback: 'not_attempted' },
    { phase: 'service_properties', exception: privateKey, errno: 1, reason: 'permission_denied', rollback: 'not_attempted' },
    { phase: 'service_properties', exception: 'ValueError', errno: -1, reason: 'permission_denied', rollback: 'not_attempted' },
    { phase: 'service_properties', exception: 'ValueError', errno: 1, reason: customerData, rollback: 'not_attempted' },
    { phase: 'service_properties', exception: 'ValueError', errno: 1, reason: 'permission_denied', rollback: 'not_attempted', extra: privateKey }
  ];
  for (const marker of invalidMarkers) {
    const password = 'password-do-not-echo';
    const failure = Object.assign(new Error('remote command failed'), {
      status: 1,
      stderr: Buffer.from(`BACKEND_PUBLISH_FAILURE ${JSON.stringify(marker)}\n${password}\n${privateKey}\n${customerData}`)
    });
    assert.equal(uploader.validatedPublisherFailure(failure), null);
    assert.throws(() => uploader.executeRemote('publish backend revision and run acceptance', 'ssh', [], {}, {}, false, () => { throw failure; }), error => {
      assert.match(error.message, /reason=remote command returned an unclassified error/);
      for (const secret of [password, privateKey, 'malicious-key-material', customerData, 'BACKEND_PUBLISH_FAILURE']) {
        assert.equal(error.message.includes(secret), false);
      }
      return true;
    });
  }
  const markerOnStdout = Object.assign(new Error('remote command failed'), {
    status: 1,
    stdout: `BACKEND_PUBLISH_FAILURE ${JSON.stringify({ phase: 'service_properties', exception: 'ValueError', errno: null, reason: 'service_configuration_invalid', rollback: 'not_attempted' })}`
  });
  assert.equal(uploader.validatedPublisherFailure(markerOnStdout), null, 'only stderr markers are parsed');
});

test('remote transport and publisher diagnostics use fixed categories only', () => {
  const cases = [
    ['ssh: connect to host server port 22: Connection timed out', 'SSH connection timed out'],
    ['ssh: connect to host server port 22: Connection refused', 'SSH connection refused'],
    ['Host key verification failed.', 'SSH host-key verification failed'],
    ['Permission denied (publickey,password).', 'SSH authentication failed'],
    ['sudo: a password is required', 'backend publisher requires non-interactive sudo permission'],
    ['staged backend preflight failed: guest preflight contract failed', 'staged backend preflight failed'],
    ['service working directory is invalid', 'service working-directory configuration is invalid'],
    ['service restart failed: systemctl exit status 1', 'backend service restart or activation failed'],
    ['daily status verification failed: unavailable', 'daily-status acceptance failed'],
    ['billing verification failed: acceptance mismatch', 'billing acceptance failed'],
    ['backend release has a missing or unsafe local dependency', 'backend bundle is incomplete or has a missing dependency'],
    ['deployed backend source hash mismatch: team.js', 'deployed backend service or source-hash check failed']
  ];
  for (const [stderr, reason] of cases) {
    const failure = Object.assign(new Error('remote command failed'), { status: 1, stderr });
    assert.throws(() => uploader.executeRemote('publish stage', 'ssh', [], {}, {}, false, () => { throw failure; }),
      error => error.message.includes(`reason=${reason}`));
  }
});


test('validated backend publisher failure marker reports enum fields without raw output', () => {
  const password = 'publisher-password-do-not-log';
  const privateKey = '-----BEGIN OPENSSH PRIVATE KEY-----\nprivate-key-material-do-not-log\n-----END OPENSSH PRIVATE KEY-----';
  const customerData = 'customer=Private Customer, debt=12345';
  const marker = {
    phase: 'service_properties',
    exception: 'ValueError',
    errno: null,
    reason: 'service_configuration_invalid',
    rollback: 'not_attempted'
  };
  const failure = Object.assign(new Error('remote command failed'), {
    status: 1,
    stderr: Buffer.from(`BACKEND_PUBLISH_PHASE {"phase":"service_properties"}\nBACKEND_PUBLISH_FAILURE ${JSON.stringify(marker)}\n${password}\n${privateKey}\n${customerData}`),
    stdout: Buffer.from(`${password}\n${customerData}`)
  });
  assert.deepEqual(uploader.validatedPublisherFailure(failure), marker);
  assert.throws(() => uploader.executeRemote('publish backend revision and run acceptance', 'ssh', [], {}, {}, false, () => { throw failure; }), error => {
    assert.match(error.message, /publisherPhase=service_properties/);
    assert.match(error.message, /publisherReason=service_configuration_invalid/);
    assert.match(error.message, /publisherException=ValueError/);
    assert.match(error.message, /publisherRollback=not_attempted/);
    for (const secret of [password, privateKey, 'private-key-material-do-not-log', customerData, 'BACKEND_PUBLISH_PHASE']) {
      assert.equal(error.message.includes(secret), false);
    }
    return true;
  });
});
test('billing verifier runs as a subprocess from the backend directory against isolated storage', () => {
  const verifier = path.resolve(__dirname, '../scripts/verify-backend-billing.cjs');
  const backendDirectory = path.resolve(__dirname, '../backend');
  const result = spawnSync(process.execPath, [verifier], {
    cwd: backendDirectory,
    encoding: 'utf8',
    timeout: 90000,
    env: { ...process.env, WAREHOUSE_DATA_FILE: path.join(os.tmpdir(), 'must-not-touch-live-data.json') }
  });
  assert.equal(result.status, 0, result.stderr || result.stdout);
  assert.deepEqual(JSON.parse(result.stdout.trim()), {
    verified: true, productionReceivable: 500, collected: 100, finalDebt: 400, shipmentReceivable: 0
  });
});

test('publisher acceptance failure restores files and restarts the prior service', () => {
  const publisher = fs.readFileSync(path.resolve(__dirname, '../scripts/publish-backend.py'), 'utf8');
  const transactionStart = publisher.indexOf('            # Replace files atomically');
  assert.notEqual(transactionStart, -1, 'publication transaction should be present');
  const transaction = publisher.slice(transactionStart);
  const acceptanceIndex = transaction.indexOf('acceptance_result = healthcheck(working, service_env)');
  const rollbackIndex = transaction.indexOf('except BaseException as primary:');
  assert.ok(acceptanceIndex >= 0);
  assert.ok(rollbackIndex > acceptanceIndex);
  assert.match(transaction, /for name in reversed\(changed\):\s+restore_file\(backup, working, name\)/);
  assert.match(transaction, /if restart:\s+try:\s+begin_phase\('rollback_restart'\)\s+restart_service\('rollback_restart'\)/);
});

test('backend provenance detects untracked server files but excludes user-uploaded product images', () => {
  const calls = [];
  const runGit = args => {
    calls.push(args);
    if (args[0] === 'rev-parse') return `${commit}\n`;
    if (args[0] === 'status') return '';
    if (args[0] === 'ls-remote') return `${commit}\trefs/heads/main\n`;
    throw new Error(`unexpected git command: ${args.join(' ')}`);
  };
  uploader.validateProvenance(commit, { runGit });
  assert.ok(calls.some(args => args.includes('--untracked-files=normal')));
  assert.ok(calls.some(args => args.includes(':(exclude,glob)backend/public/uploads/**')));
});
