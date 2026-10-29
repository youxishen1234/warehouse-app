'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const crypto = require('node:crypto');
const vm = require('node:vm');
const { spawnSync } = require('node:child_process');
const provisioner = require('../scripts/provision-print-receiver.cjs');

const keys = crypto.generateKeyPairSync('rsa', {
  modulusLength: 4096,
  publicKeyEncoding: { type: 'spki', format: 'pem' },
  privateKeyEncoding: { type: 'pkcs8', format: 'pem' }
});
const publicKey = Buffer.from(keys.publicKey).toString('base64');
const fixtureConfig = {
  origin: provisioner.ORIGIN,
  agent: 'a'.repeat(64),
  client: 'b'.repeat(64),
  device: { id: crypto.randomUUID(), name: '仓库打印电脑', printer: 'EPSON LQ-630K' }
};

function decrypt(envelope, privateKey = keys.privateKey) {
  const key = crypto.privateDecrypt({
    key: privateKey,
    padding: crypto.constants.RSA_PKCS1_OAEP_PADDING,
    oaepHash: 'sha256'
  }, Buffer.from(envelope.wrapped_key, 'base64'));
  const decipher = crypto.createDecipheriv('aes-256-gcm', key, Buffer.from(envelope.iv, 'base64'));
  decipher.setAAD(Buffer.from(envelope.aad, 'base64'));
  decipher.setAuthTag(Buffer.from(envelope.tag, 'base64'));
  return JSON.parse(Buffer.concat([
    decipher.update(Buffer.from(envelope.ciphertext, 'base64')),
    decipher.final()
  ]).toString('utf8'));
}

function temporary(t) {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'printer-provision-test-'));
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
  return directory;
}

function fixtureInputs() {
  return {
    PRINTER_PUBLIC_KEY: publicKey,
    PRINTER_NAME: fixtureConfig.device.printer,
    PRINTER_DEVICE_NAME: fixtureConfig.device.name
  };
}

test('pairing requires a public RSA 4096 key and bounded device/printer names before connecting', () => {
  assert.equal(provisioner.validateProvisionInputs(fixtureInputs()).printerName, 'EPSON LQ-630K');
  const weak = crypto.generateKeyPairSync('rsa', {
    modulusLength: 2048,
    publicKeyEncoding: { type: 'spki', format: 'pem' },
    privateKeyEncoding: { type: 'pkcs8', format: 'pem' }
  });
  for (const invalid of ['', 'not-base64!', Buffer.from(weak.publicKey).toString('base64'), Buffer.from(keys.privateKey).toString('base64')]) {
    assert.throws(() => provisioner.validateProvisionInputs({ ...fixtureInputs(), PRINTER_PUBLIC_KEY: invalid }));
  }
  for (const [name, value] of [
    ['PRINTER_NAME', ''],
    ['PRINTER_NAME', 'p'.repeat(257)],
    ['PRINTER_DEVICE_NAME', 'd'.repeat(81)],
    ['PRINTER_DEVICE_NAME', 'hidden\ncommand']
  ]) {
    assert.throws(() => provisioner.validateProvisionInputs({ ...fixtureInputs(), [name]: value }), /invalid/);
  }
});

test('pairing envelope round trips and authenticates its ciphertext and AAD', () => {
  const envelope = provisioner.createEnvelope(fixtureConfig, publicKey);
  assert.deepEqual(decrypt(provisioner.validateEnvelope(envelope)), fixtureConfig);
  const serialized = JSON.stringify(envelope);
  assert.equal(serialized.includes(fixtureConfig.agent), false);
  assert.equal(serialized.includes(fixtureConfig.client), false);
  assert.equal(serialized.includes(fixtureConfig.device.name), false);
  const ciphertext = Buffer.from(envelope.ciphertext, 'base64');
  ciphertext[0] ^= 1;
  assert.throws(() => decrypt({ ...envelope, ciphertext: ciphertext.toString('base64') }));
  assert.throws(() => decrypt({ ...envelope, aad: Buffer.from('wrong context').toString('base64') }));
  assert.throws(() => provisioner.validateEnvelope({ ...envelope, agent: fixtureConfig.agent }), /invalid encrypted data/);
  assert.throws(() => provisioner.parseRemoteOutput(JSON.stringify(fixtureConfig)), /invalid encrypted data/);
});

test('server registration preserves all existing devices/jobs and returns encrypted credentials only', t => {
  const directory = temporary(t);
  const remoteFile = path.join(directory, 'remote-print.json');
  const moduleFile = path.join(directory, 'remote-print.js');
  fs.copyFileSync(path.resolve(__dirname, '../backend/remote-print.js'), moduleFile);
  const previous = {
    devices: [{ id: crypto.randomUUID(), name: 'other computer', printer: 'other queue', agent_hash: 'kept-a', client_hash: 'kept-c' }],
    jobs: [{ id: 'existing-waiting-job', device_id: 'other-device', status: 'waiting', note: { receiver: 'private customer' } }],
    metadata: { preserved: true }
  };
  fs.writeFileSync(remoteFile, JSON.stringify(previous), { mode: 0o600 });
  const run = input => spawnSync(process.execPath, ['-e', provisioner.REGISTRATION_NODE_SOURCE], {
    input: JSON.stringify(input),
    encoding: 'utf8',
    timeout: 15000,
    windowsHide: true
  });
  const input = {
    moduleFile,
    remoteFile,
    publicKey,
    deviceName: fixtureConfig.device.name,
    printerName: fixtureConfig.device.printer
  };
  const result = run(input);
  assert.equal(result.status, 0, result.stderr);
  assert.equal(result.stderr, '');
  const envelope = provisioner.parseRemoteOutput(result.stdout);
  const config = decrypt(envelope);
  assert.equal(config.origin, provisioner.ORIGIN);
  assert.equal(config.device.name, input.deviceName);
  assert.equal(config.device.printer, input.printerName);
  assert.match(config.agent, /^[a-f0-9]{64}$/);
  assert.match(config.client, /^[a-f0-9]{64}$/);
  assert.equal(result.stdout.includes(config.agent), false);
  assert.equal(result.stdout.includes(config.client), false);
  assert.equal(result.stdout.includes('private customer'), false);
  const state = JSON.parse(fs.readFileSync(remoteFile, 'utf8'));
  assert.equal(state.devices.length, 2);
  assert.deepEqual(state.devices[0], previous.devices[0]);
  assert.deepEqual(state.jobs, previous.jobs);
  assert.deepEqual(state.metadata, previous.metadata);
  assert.equal(state.devices[1].agent_hash, crypto.createHash('sha256').update(config.agent).digest('hex'));
  assert.equal(state.devices[1].client_hash, crypto.createHash('sha256').update(config.client).digest('hex'));
  if (process.platform !== 'win32') assert.equal(fs.statSync(remoteFile).mode & 0o777, 0o600);
  const beforeDuplicate = fs.readFileSync(remoteFile);
  const duplicate = run(input);
  assert.equal(duplicate.status, 0, duplicate.stderr);
  assert.deepEqual(JSON.parse(duplicate.stdout), envelope, 'a lost response is recovered from the encrypted receipt');
  assert.deepEqual(fs.readFileSync(remoteFile), beforeDuplicate, 'a retry must not register another device or alter jobs');
  const receipts = fs.readdirSync(remoteFile + '.provision-receipts');
  assert.equal(receipts.length, 1);
  const receiptText = fs.readFileSync(path.join(remoteFile + '.provision-receipts', receipts[0]), 'utf8');
  assert.equal(receiptText.includes(config.agent), false);
  assert.equal(receiptText.includes(config.client), false);
  assert.equal(receiptText.includes(config.device.name), false);
  if (process.platform !== 'win32') {
    assert.equal(fs.statSync(remoteFile + '.provision-receipts').mode & 0o777, 0o700);
    assert.equal(fs.statSync(path.join(remoteFile + '.provision-receipts', receipts[0])).mode & 0o777, 0o600);
  }
  const changedKey = crypto.generateKeyPairSync('rsa', {
    modulusLength: 4096,
    publicKeyEncoding: { type: 'spki', format: 'pem' },
    privateKeyEncoding: { type: 'pkcs8', format: 'pem' }
  });
  const reRegistration = run({ ...input, publicKey: Buffer.from(changedKey.publicKey).toString('base64') });
  assert.equal(reRegistration.status, 1);
  assert.equal(reRegistration.stdout, '');
  assert.equal(reRegistration.stderr.trim(), 'PRINTER_PROVISION_FAILURE registration');
  assert.deepEqual(fs.readFileSync(remoteFile), beforeDuplicate, 'a different key must not replace an existing device');
});

test('failed encrypted receipt persistence rolls back only the new registration before restoring service', t => {
  const directory = temporary(t);
  const remoteFile = path.join(directory, 'remote-print.json');
  const moduleFile = path.join(directory, 'remote-print.js');
  fs.copyFileSync(path.resolve(__dirname, '../backend/remote-print.js'), moduleFile);
  const previous = Buffer.from(JSON.stringify({
    devices: [{ id: 'kept-device', name: 'kept computer', printer: 'kept queue' }],
    jobs: [{ id: 'kept-job', note: { receiver: 'private' }, status: 'processing' }]
  }, null, 2));
  fs.writeFileSync(remoteFile, previous, { mode: 0o600 });
  const failure = String.raw`
const originalFs = require('node:fs');
const originalWrite = originalFs.writeFileSync;
originalFs.writeFileSync = function(file, ...args) {
  if (String(file).includes('.provision-receipts/') && String(file).includes('.tmp-')) throw new Error('isolated receipt failure');
  return originalWrite.call(this, file, ...args);
};
`;
  const result = spawnSync(process.execPath, ['-e', failure + provisioner.REGISTRATION_NODE_SOURCE], {
    input: JSON.stringify({
      moduleFile, remoteFile, publicKey,
      deviceName: fixtureConfig.device.name,
      printerName: fixtureConfig.device.printer
    }),
    encoding: 'utf8',
    timeout: 15000,
    windowsHide: true
  });
  assert.equal(result.status, 1);
  assert.equal(result.stdout, '');
  assert.equal(result.stderr.trim(), 'PRINTER_PROVISION_FAILURE registration');
  assert.deepEqual(fs.readFileSync(remoteFile), previous, 'all original devices/jobs and exact snapshot bytes remain intact');
  assert.deepEqual(fs.readdirSync(remoteFile + '.provision-receipts'), []);
});

function runRemote(options = {}) {
  const working = '/opt/shuguang/backend';
  const moduleFile = working + '/remote-print.js';
  const moduleBytes = Buffer.from('trusted print store source');
  const payload = {
    publicKey,
    printerName: fixtureConfig.device.printer,
    deviceName: fixtureConfig.device.name,
    registrationSource: provisioner.REGISTRATION_NODE_SOURCE,
    moduleSha256: crypto.createHash('sha256').update(moduleBytes).digest('hex')
  };
  if (options.hashMismatch) payload.moduleSha256 = '0'.repeat(64);
  const envelope = provisioner.createEnvelope(fixtureConfig, publicKey);
  const operations = [];
  const stdout = [], stderr = [];
  let active = options.inactive !== true;
  let childRequest;
  const mockProcess = {
    argv: ['node', Buffer.from(JSON.stringify(payload)).toString('base64'), working],
    on() {},
    stdout: { write: text => stdout.push(text) },
    stderr: { write: text => stderr.push(text) }
  };
  const environment = options.defaultData
    ? 'PATH=/usr/bin:/bin\0PRIVATE_VALUE=must=not=leave=server\0'
    : 'WAREHOUSE_DATA_FILE=/private/store/business=data.json\0PATH=/usr/bin:/bin\0PRIVATE_VALUE=must=not=leave=server\0';
  const mockFs = {
    existsSync(file) { return file === moduleFile || (options.writerStillPresent && file === '/proc/321'); },
    realpathSync(file) {
      if (file === '/proc/321/cwd' || file === working) return working;
      if (file === '/proc/321/exe') return '/usr/bin/node';
      throw new Error('unexpected path metadata access ' + file);
    },
    readFileSync(file, encoding) {
      operations.push('read:' + file);
      if (file === '/proc/321/environ') return Buffer.from(environment);
      if (file === '/proc/321/status') return 'Uid:\t1001\t1001\t1001\t1001\nGid:\t1002\t1002\t1002\t1002\n';
      if (file === moduleFile && !encoding) return moduleBytes;
      throw new Error('must not read business data ' + file);
    }
  };
  const mockChild = {
    execFileSync(command, args, childOptions) {
      if (command === 'systemctl') {
        if (args[0] === 'show') {
          return `ActiveState=${active ? 'active' : 'inactive'}\nMainPID=${active ? 321 : 0}\nWorkingDirectory=${options.changedWorking ? '/changed/backend' : working}\n`;
        }
        operations.push(args[0]);
        if (args[0] === 'stop') {
          active = false;
          if (options.stopFailure) throw new Error('stop failed with private detail');
          return '';
        }
        if (args[0] === 'start') {
          if (options.restoreFailure) throw new Error('start failed with private detail');
          active = true;
          return '';
        }
        throw new Error('unexpected service operation');
      }
      assert.equal(command, '/usr/bin/node');
      operations.push('register');
      assert.equal(active, false, 'the live JSON writer must be stopped before registration');
      assert.equal(childOptions.uid, 1001, 'registration must not create a root-owned 0600 queue');
      assert.equal(childOptions.gid, 1002);
      assert.equal(childOptions.cwd, working);
      assert.deepEqual(Object.keys(childOptions.env).sort(), ['LANG', 'PATH']);
      childRequest = JSON.parse(childOptions.input);
      if (options.registrationFailure) throw new Error('sensitive credentials must not be logged ' + fixtureConfig.agent);
      return JSON.stringify(envelope);
    },
    spawnSync(command, args) {
      assert.equal(command, 'systemctl');
      assert.equal(args[0], 'is-active');
      return { status: active ? 0 : 3 };
    }
  };
  vm.runInNewContext(provisioner.REMOTE_NODE_SOURCE, {
    require(name) {
      if (name === 'node:fs') return mockFs;
      if (name === 'node:path') return path.posix;
      if (name === 'node:child_process') return mockChild;
      if (name === 'node:crypto') return crypto;
      throw new Error('unexpected import');
    },
    process: mockProcess,
    Buffer,
    SharedArrayBuffer,
    Int32Array,
    Atomics,
    Date
  }, { timeout: 3000 });
  return { stdout: stdout.join(''), stderr: stderr.join(''), active, operations, childRequest, status: mockProcess.exitCode || 0 };
}

test('locked remote orchestration uses the running process paths and service identity, then restores service before output', () => {
  const result = runRemote();
  assert.equal(result.status, 0, result.stderr);
  assert.equal(result.active, true);
  assert.equal(result.childRequest.remoteFile, '/private/store/remote-print.json');
  assert.equal(result.childRequest.moduleFile, '/opt/shuguang/backend/remote-print.js');
  assert.equal(result.operations.indexOf('stop') < result.operations.indexOf('register'), true);
  assert.equal(result.operations.indexOf('register') < result.operations.indexOf('start'), true);
  assert.deepEqual(decrypt(provisioner.parseRemoteOutput(result.stdout)), fixtureConfig);
  assert.equal(result.stderr, '');
  assert.equal(result.operations.some(operation => operation === 'read:/private/store/business=data.json'), false);
  const defaultData = runRemote({ defaultData: true });
  assert.equal(defaultData.childRequest.remoteFile, '/opt/shuguang/backend/remote-print.json');
});

test('remote orchestration restores the active service after stop or registration failures without leaking diagnostics', () => {
  for (const option of ['stopFailure', 'registrationFailure']) {
    const result = runRemote({ [option]: true });
    assert.equal(result.status, 1);
    assert.equal(result.active, true);
    assert.equal(result.stdout, '');
    assert.match(result.stderr, /^PRINTER_PROVISION_FAILURE phase=service_restore restored=true\n$/);
    assert.equal(result.stderr.includes(fixtureConfig.agent), false);
    assert.equal(result.stderr.includes('private'), false);
    assert.equal(result.operations.includes('start'), true);
  }
  const restoreFailure = runRemote({ restoreFailure: true });
  assert.equal(restoreFailure.status, 1);
  assert.equal(restoreFailure.stdout, '', 'a pairing is not returned while service restoration failed');
  assert.match(restoreFailure.stderr, /phase=service_restore restored=false/);
  const writerAlive = runRemote({ writerStillPresent: true });
  assert.equal(writerAlive.status, 1);
  assert.equal(writerAlive.active, true);
  assert.equal(writerAlive.operations.includes('register'), false, 'a stopped-looking service cannot race with a surviving writer');
  assert.equal(writerAlive.stdout, '');
});

test('unsafe source, changed working directory, or originally inactive service refuses provisioning without changing service state', () => {
  for (const option of ['hashMismatch', 'changedWorking', 'inactive']) {
    const result = runRemote({ [option]: true });
    assert.equal(result.status, 1);
    assert.equal(result.stdout, '');
    assert.equal(result.operations.includes('stop'), false);
    assert.equal(result.operations.includes('start'), false);
    assert.equal(result.operations.includes('register'), false);
  }
});

test('CI helper accepts encrypted output only and stages only the envelope artifact', t => {
  const directory = temporary(t);
  const output = path.join(directory, 'envelope.json');
  let command;
  const env = { ...fixtureInputs(), PRINTER_PROVISION_OUTPUT: output };
  const envelope = provisioner.createEnvelope(fixtureConfig, publicKey);
  const result = provisioner.provision({
    env,
    connection: () => ({ target: 'ci@example.invalid', port: '22' }),
    withAuth: callback => callback({ PATH: '/safe' }, false),
    executeRemote(_phase, executable, args) {
      assert.equal(executable, 'ssh');
      command = args.at(-1);
      return JSON.stringify(envelope);
    }
  });
  assert.equal(result.output, output);
  assert.deepEqual(decrypt(JSON.parse(fs.readFileSync(output, 'utf8'))), fixtureConfig);
  assert.equal(command.includes(fixtureConfig.agent), false);
  assert.equal(command.includes(fixtureConfig.client), false);
  assert.match(command, /\.backend-release\.lock/);
  assert.match(command, /lock_root=/);
  assert.equal(fs.readdirSync(directory).join(','), 'envelope.json');
  assert.throws(() => provisioner.provision({
    env: { ...env, PRINTER_PUBLIC_KEY: '' },
    connection() { assert.fail('invalid public key must fail before accessing SSH settings'); }
  }), /PRINTER_PUBLIC_KEY/);
});
