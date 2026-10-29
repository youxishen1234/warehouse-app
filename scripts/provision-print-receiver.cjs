'use strict';

const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const { execFileSync } = require('node:child_process');
const {
  connection,
  executeRemote,
  withAuth
} = require('./upload-backend.cjs');

const ORIGIN = 'https://youxishen.online';
const ENVELOPE_VERSION = 1;
const AAD = Buffer.from('warehouse-print-receiver-provision-v1', 'utf8');
const DEFAULT_OUTPUT = path.resolve('release/printer-provision-envelope.json');
const TOKEN = /^[a-f0-9]{64}$/;
const DEVICE_ID = /^[0-9a-f-]{36}$/i;

function shellQuote(value) {
  return "'" + String(value).replaceAll("'", "'\\''") + "'";
}

function decodePublicKey(input) {
  const encoded = String(input || '').trim();
  if (!encoded || encoded.length % 4 !== 0 || !/^[A-Za-z0-9+/]+={0,2}$/.test(encoded)) {
    throw new Error('PRINTER_PUBLIC_KEY must be base64-encoded PEM');
  }
  let pem;
  try {
    pem = Buffer.from(encoded, 'base64').toString('utf8');
  } catch {
    throw new Error('PRINTER_PUBLIC_KEY is not valid base64');
  }
  if (!pem.includes('BEGIN PUBLIC KEY') && !pem.includes('BEGIN RSA PUBLIC KEY')) {
    throw new Error('PRINTER_PUBLIC_KEY must contain an RSA public key');
  }
  if (/BEGIN (?:RSA )?PRIVATE KEY/.test(pem)) {
    throw new Error('PRINTER_PUBLIC_KEY must not contain a private key');
  }
  let key;
  try {
    key = crypto.createPublicKey(pem);
  } catch {
    throw new Error('PRINTER_PUBLIC_KEY is not a valid public key');
  }
  if (key.type !== 'public' || key.asymmetricKeyType !== 'rsa'
    || Number(key.asymmetricKeyDetails?.modulusLength || 0) < 4096) {
    throw new Error('PRINTER_PUBLIC_KEY must be an RSA 4096-or-larger public key');
  }
  return { encoded, pem, key };
}

function textInput(name, value, maxLength) {
  const text = String(value || '').trim();
  if (!text || text.length > maxLength || /[\u0000-\u001f\u007f]/.test(text)) {
    throw new Error(`${name} is invalid`);
  }
  return text;
}

function validateProvisionInputs(env = process.env) {
  const publicKey = decodePublicKey(env.PRINTER_PUBLIC_KEY);
  const deviceName = textInput('PRINTER_DEVICE_NAME', env.PRINTER_DEVICE_NAME, 80);
  const printerName = textInput('PRINTER_NAME', env.PRINTER_NAME, 256);
  return { publicKey, deviceName, printerName };
}

function validateRemoteConfig(value) {
  let config = value;
  if (typeof config === 'string') {
    try { config = JSON.parse(config); } catch { throw new Error('remote printer registration returned invalid data'); }
  }
  if (!config || typeof config !== 'object' || Array.isArray(config)) {
    throw new Error('remote printer registration returned invalid data');
  }
  if (config.origin !== ORIGIN || !TOKEN.test(String(config.agent || '')) || !TOKEN.test(String(config.client || ''))) {
    throw new Error('remote printer registration returned invalid credentials');
  }
  const device = config.device;
  if (!device || typeof device !== 'object' || Array.isArray(device)
    || !DEVICE_ID.test(String(device.id || ''))
    || typeof device.name !== 'string' || !device.name
    || typeof device.printer !== 'string' || !device.printer) {
    throw new Error('remote printer registration returned invalid device');
  }
  return {
    origin: ORIGIN,
    agent: config.agent,
    client: config.client,
    device: {
      id: device.id,
      name: device.name,
      printer: device.printer,
      ...(Number.isFinite(device.last_seen) ? { last_seen: device.last_seen } : {}),
      ...(typeof device.online === 'boolean' ? { online: device.online } : {}),
      ...(typeof device.ready === 'boolean' ? { ready: device.ready } : {})
    }
  };
}

function createEnvelope(config, publicKeyInput, now = new Date()) {
  const publicKey = publicKeyInput?.key ? publicKeyInput : decodePublicKey(publicKeyInput);
  const validated = validateRemoteConfig(config);
  const plaintext = Buffer.from(JSON.stringify(validated), 'utf8');
  const aesKey = crypto.randomBytes(32);
  const iv = crypto.randomBytes(12);
  const cipher = crypto.createCipheriv('aes-256-gcm', aesKey, iv);
  cipher.setAAD(AAD);
  const ciphertext = Buffer.concat([cipher.update(plaintext), cipher.final()]);
  const tag = cipher.getAuthTag();
  const wrappedKey = crypto.publicEncrypt({
    key: publicKey.key,
    padding: crypto.constants.RSA_PKCS1_OAEP_PADDING,
    oaepHash: 'sha256'
  }, aesKey);
  return {
    version: ENVELOPE_VERSION,
    algorithm: 'RSA-OAEP-SHA256+A256GCM',
    aad: AAD.toString('base64'),
    wrapped_key: wrappedKey.toString('base64'),
    iv: iv.toString('base64'),
    tag: tag.toString('base64'),
    ciphertext: ciphertext.toString('base64'),
    created_at: new Date(now).toISOString()
  };
}

function writeEnvelope(output, envelope) {
  const target = path.resolve(output || DEFAULT_OUTPUT);
  fs.mkdirSync(path.dirname(target), { recursive: true });
  const temporary = `${target}.tmp-${process.pid}-${crypto.randomUUID()}`;
  try {
    const contents = JSON.stringify(envelope) + '\n';
    fs.writeFileSync(temporary, contents, { mode: 0o600, flag: 'wx' });
    fs.renameSync(temporary, target);
    try { fs.chmodSync(target, 0o600); } catch {}
  } finally {
    if (fs.existsSync(temporary)) {
      try { fs.unlinkSync(temporary); } catch {}
    }
  }
  return target;
}

function validateEnvelope(value) {
  let envelope;
  try { envelope = typeof value === 'string' ? JSON.parse(value) : value; } catch {
    throw new Error('remote printer registration returned invalid encrypted data');
  }
  const bytes = (encoded, length, maximum = length) => {
    if (typeof encoded !== 'string' || encoded.length % 4 !== 0 || !/^[A-Za-z0-9+/]+={0,2}$/.test(encoded)) return false;
    const decoded = Buffer.from(encoded, 'base64');
    return decoded.length >= length && decoded.length <= maximum && decoded.toString('base64') === encoded;
  };
  if (!envelope || typeof envelope !== 'object' || Array.isArray(envelope)
    || Object.keys(envelope).sort().join(',') !== 'aad,algorithm,ciphertext,created_at,iv,tag,version,wrapped_key'
    || envelope.version !== ENVELOPE_VERSION || envelope.algorithm !== 'RSA-OAEP-SHA256+A256GCM'
    || envelope.aad !== AAD.toString('base64')
    || !bytes(envelope.wrapped_key, 512, 2048) || !bytes(envelope.iv, 12)
    || !bytes(envelope.tag, 16) || !bytes(envelope.ciphertext, 1, 8192)
    || typeof envelope.created_at !== 'string'
    || !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/.test(envelope.created_at)) {
    throw new Error('remote printer registration returned invalid encrypted data');
  }
  return envelope;
}

// This program runs as the existing service user. Plaintext credentials never
// cross the SSH channel, enter argv/environment, or touch a staging file.
const REGISTRATION_NODE_SOURCE = [
  "'use strict';",
  "const fs = require('node:fs'), crypto = require('node:crypto');",
  `const ORIGIN = ${JSON.stringify(ORIGIN)};`,
  `const ENVELOPE_VERSION = ${ENVELOPE_VERSION};`,
  `const AAD = Buffer.from(${JSON.stringify(AAD.toString('base64'))}, 'base64');`,
  `const TOKEN = ${TOKEN.toString()}, DEVICE_ID = ${DEVICE_ID.toString()};`,
  decodePublicKey.toString(),
  validateRemoteConfig.toString(),
  createEnvelope.toString(),
  validateEnvelope.toString(),
  String.raw`
try {
  const input = JSON.parse(fs.readFileSync(0, 'utf8'));
  const publicKey = decodePublicKey(input.publicKey);
  const existed = fs.existsSync(input.remoteFile);
  const previousBytes = existed ? fs.readFileSync(input.remoteFile) : null;
  const previous = existed ? JSON.parse(previousBytes.toString('utf8')) : { devices: [], jobs: [] };
  if (!Array.isArray(previous.devices) || !Array.isArray(previous.jobs)) throw new Error('invalid printer store');
  const requestId = crypto.createHash('sha256').update(JSON.stringify({
    publicKey: publicKey.key.export({ type: 'spki', format: 'der' }).toString('base64'),
    name: input.deviceName,
    printer: input.printerName,
    origin: ORIGIN
  })).digest('hex');
  const receiptDirectory = input.remoteFile + '.provision-receipts';
  fs.mkdirSync(receiptDirectory, { recursive: true, mode: 0o700 });
  if (fs.lstatSync(receiptDirectory).isSymbolicLink() || !fs.statSync(receiptDirectory).isDirectory()) throw new Error('invalid receipt directory');
  fs.chmodSync(receiptDirectory, 0o700);
  const receiptFile = receiptDirectory + '/' + requestId + '.json';
  if (fs.existsSync(receiptFile)) {
    if (fs.lstatSync(receiptFile).isSymbolicLink()) throw new Error('invalid receipt');
    const receipt = JSON.parse(fs.readFileSync(receiptFile, 'utf8'));
    const device = previous.devices.find(row => row && row.id === receipt.device_id && row.name === input.deviceName && row.printer === input.printerName);
    if (receipt.request_id !== requestId || !device) throw new Error('receipt does not match device');
    process.stdout.write(JSON.stringify(validateEnvelope(receipt.envelope)));
  } else {
  if (previous.devices.some(device => device && device.name === input.deviceName && device.printer === input.printerName)) {
    throw new Error('printer device already exists');
  }
  const { createStore } = require(input.moduleFile);
  let registered = false, receiptCommitted = false;
  const temporaryReceipt = receiptFile + '.tmp-' + crypto.randomUUID();
  try {
    const result = createStore(input.remoteFile).register(input.deviceName, input.printerName);
    registered = true;
    const envelope = createEnvelope({ origin: ORIGIN, ...result }, publicKey);
    fs.writeFileSync(temporaryReceipt, JSON.stringify({
      request_id: requestId,
      device_id: result.device.id,
      envelope
    }), { mode: 0o600, flag: 'wx' });
    const fd = fs.openSync(temporaryReceipt, 'r+');
    try { fs.fsyncSync(fd); } finally { fs.closeSync(fd); }
    fs.renameSync(temporaryReceipt, receiptFile);
    receiptCommitted = true;
    process.stdout.write(JSON.stringify(envelope));
  } catch (error) {
    // The live writer is stopped and the shared release lock is held. If
    // persistence of the encrypted receipt fails, restore only this
    // registration's exact pre-write snapshot before the service resumes.
    if (registered && !receiptCommitted) {
      if (existed) {
        const rollback = input.remoteFile + '.provision-rollback-' + crypto.randomUUID();
        try {
          fs.writeFileSync(rollback, previousBytes, { mode: 0o600, flag: 'wx' });
          fs.renameSync(rollback, input.remoteFile);
        } finally { if (fs.existsSync(rollback)) fs.unlinkSync(rollback); }
      } else {
        fs.unlinkSync(input.remoteFile);
      }
    }
    throw error;
  } finally { if (fs.existsSync(temporaryReceipt)) fs.unlinkSync(temporaryReceipt); }
  }
} catch {
  process.stderr.write('PRINTER_PROVISION_FAILURE registration\n');
  process.exitCode = 1;
}
`
].join('\n');

/*
 * The lock is opened by util-linux flock before this Node program starts.
 * It is the same .backend-release.lock used by publish-backend.py, so the
 * deployment cannot restart the service during registration. The service is
 * stopped briefly because its existing JSON store has no cross-process lock.
 */
const REMOTE_NODE_SOURCE = String.raw`
'use strict';
const fs = require('node:fs');
const path = require('node:path');
const cp = require('node:child_process');
const crypto = require('node:crypto');
const payload = JSON.parse(Buffer.from(process.argv[1] || '', 'base64').toString('utf8'));
const expectedWorking = process.argv[2];
const service = 'shuguang.service';
const parseAssignments = (text, separator) => Object.fromEntries(text.split(separator).filter(line => line.includes('=')).map(line => {
  const equals = line.indexOf('=');
  return [line.slice(0, equals), line.slice(equals + 1)];
}));
const safeRun = (args, options = {}) => cp.execFileSync('systemctl', args, {
  encoding: 'utf8',
  stdio: ['ignore', 'pipe', 'pipe'],
  timeout: 45000,
  ...options
});
const sleep = ms => {
  const shared = new Int32Array(new SharedArrayBuffer(4));
  Atomics.wait(shared, 0, 0, ms);
};
const waitActive = expected => {
  const deadline = Date.now() + 30000;
  while (Date.now() < deadline) {
    const active = cp.spawnSync('systemctl', ['is-active', '--quiet', service], { stdio: 'ignore' }).status === 0;
    if (active === expected) return;
    sleep(250);
  }
  throw new Error('service state did not settle');
};
let phase = 'service_inspection', restored = true;
for (const signal of ['SIGTERM', 'SIGINT', 'SIGHUP']) process.on(signal, () => {});
try {
  const show = safeRun(['show', service, '--property=ActiveState', '--property=MainPID', '--property=WorkingDirectory', '--no-pager']);
  const properties = parseAssignments(show, /\r?\n/);
  if (properties.WorkingDirectory !== expectedWorking || !path.isAbsolute(expectedWorking) || expectedWorking === '/') {
    throw new Error('service working directory changed');
  }
  const originalActive = properties.ActiveState === 'active';
  const mainPid = Number(properties.MainPID || 0);
  // Refuse to start an originally inactive service just to discover its data
  // paths; /proc provides the exact running configuration without printing it.
  if (!originalActive || !Number.isSafeInteger(mainPid) || mainPid <= 0) throw new Error('service is not active');
  const procRoot = '/proc/' + mainPid;
  const actualCwd = fs.realpathSync(procRoot + '/cwd');
  if (actualCwd !== fs.realpathSync(expectedWorking)) throw new Error('service process directory differs');
  const nodeExe = fs.realpathSync(procRoot + '/exe');
  const procEnv = parseAssignments(fs.readFileSync(procRoot + '/environ').toString('utf8'), '\0');
  const status = fs.readFileSync(procRoot + '/status', 'utf8');
  const uid = Number(status.match(/^Uid:\s+\d+\s+(\d+)/m)?.[1]);
  const gid = Number(status.match(/^Gid:\s+\d+\s+(\d+)/m)?.[1]);
  if (!Number.isSafeInteger(uid) || uid <= 0 || !Number.isSafeInteger(gid) || gid < 0) throw new Error('invalid service identity');
  const candidates = [path.join(actualCwd, 'remote-print.js'), path.join(actualCwd, 'backend', 'remote-print.js')].filter(candidate => fs.existsSync(candidate));
  if (candidates.length !== 1) throw new Error('remote print module is ambiguous');
  const moduleFile = candidates[0];
  const moduleBytes = fs.readFileSync(moduleFile);
  if (crypto.createHash('sha256').update(moduleBytes).digest('hex') !== payload.moduleSha256) throw new Error('remote print source differs');
  const dataFile = procEnv.WAREHOUSE_DATA_FILE
    ? path.resolve(actualCwd, procEnv.WAREHOUSE_DATA_FILE)
    : path.join(path.dirname(moduleFile), 'data.json');
  const remoteFile = procEnv.WAREHOUSE_REMOTE_PRINT_FILE
    ? path.resolve(actualCwd, procEnv.WAREHOUSE_REMOTE_PRINT_FILE)
    : path.join(path.dirname(dataFile), 'remote-print.json');
  const resolved = file => fs.existsSync(file) ? fs.realpathSync(file) : file;
  if (resolved(remoteFile) === resolved(dataFile)) throw new Error('printer store cannot be the business store');
  let restoreRequired = false, envelope;
  try {
    phase = 'service_stop';
    restoreRequired = true;
    restored = false;
    safeRun(['stop', service]);
    waitActive(false);
    const stoppedState = parseAssignments(safeRun(['show', service, '--property=ActiveState', '--property=MainPID', '--no-pager']), /\r?\n/);
    if (Number(stoppedState.MainPID || 0) !== 0 || !['inactive', 'failed'].includes(stoppedState.ActiveState) || fs.existsSync(procRoot)) {
      throw new Error('original service writer has not exited');
    }
    phase = 'registration';
    envelope = cp.execFileSync(nodeExe, ['-e', payload.registrationSource], {
      cwd: actualCwd,
      uid,
      gid,
      input: JSON.stringify({ remoteFile, moduleFile, publicKey: payload.publicKey, deviceName: payload.deviceName, printerName: payload.printerName }),
      encoding: 'utf8',
      stdio: ['pipe', 'pipe', 'pipe'],
      maxBuffer: 256 * 1024,
      timeout: 30000,
      env: { PATH: procEnv.PATH || '/usr/bin:/bin', LANG: 'C.UTF-8' }
    });
  } finally {
    if (restoreRequired && originalActive) {
      phase = 'service_restore';
      safeRun(['start', service]);
      waitActive(true);
      restored = true;
    }
  }
  phase = 'encrypted_output';
  // Do not release encrypted pairing material until the original service is
  // running again. Child output contains the authenticated envelope only.
  const parsed = JSON.parse(envelope);
  if (parsed.version !== 1 || parsed.algorithm !== 'RSA-OAEP-SHA256+A256GCM' || !parsed.ciphertext) throw new Error('invalid envelope');
  process.stdout.write(JSON.stringify(parsed));
} catch {
  process.stderr.write('PRINTER_PROVISION_FAILURE phase=' + phase + ' restored=' + restored + '\n');
  process.exitCode = 1;
}
`;

function buildRemoteCommand(payload) {
  const data = Buffer.from(JSON.stringify(payload), 'utf8').toString('base64');
  const source = Buffer.from(REMOTE_NODE_SOURCE, 'utf8').toString('base64');
  const remoteShell = [
    'set -eu',
    `working="$(systemctl show shuguang.service --property=WorkingDirectory --value --no-pager)"`,
    'case "$working" in /*) ;; *) exit 1 ;; esac',
    '[ "$working" != / ]',
    'lock_root="$(dirname -- "$working")"',
    `source="$(printf %s ${shellQuote(source)} | base64 -d)"`,
    `payload_b64=${shellQuote(data)}`,
    'if [ "$(id -u)" -eq 0 ]; then',
    '  exec flock -x -w 120 -- "$lock_root/.backend-release.lock" node -e "$source" "$payload_b64" "$working"',
    'fi',
    'exec sudo -n flock -x -w 120 -- "$lock_root/.backend-release.lock" node -e "$source" "$payload_b64" "$working"'
  ].join('\n');
  return `sh -c ${shellQuote(remoteShell)}`;
}

function parseRemoteOutput(raw) {
  const text = String(raw || '').trim();
  if (!text || text.length > 64 * 1024) throw new Error('remote printer registration returned no data');
  return validateEnvelope(text);
}

function provision(options = {}) {
  const env = options.env || process.env;
  const { publicKey, deviceName, printerName } = validateProvisionInputs(env);
  const c = (options.connection || connection)(env);
  const execute = options.execute || execFileSync;
  const remoteRunner = options.executeRemote || ((phase, command, args, requestOptions, authEnv, password) =>
    executeRemote(phase, command, args, requestOptions, authEnv, password, execute));
  const authenticate = options.withAuth || withAuth;
  const moduleSha256 = crypto.createHash('sha256').update(fs.readFileSync(path.resolve(__dirname, '../backend/remote-print.js'))).digest('hex');
  const payload = { publicKey: publicKey.encoded, deviceName, printerName, moduleSha256, registrationSource: REGISTRATION_NODE_SOURCE };
  const remoteEnvelope = authenticate((authEnv, password) => remoteRunner(
    'provision remote printer receiver',
    'ssh',
    ['-p', c.port, '-o', 'ConnectTimeout=15', c.target, buildRemoteCommand(payload)],
    { cwd: path.resolve(__dirname, '..'), maxBuffer: 256 * 1024 },
    authEnv,
    password
  ), env, execute);
  const envelope = parseRemoteOutput(remoteEnvelope);
  const output = writeEnvelope(env.PRINTER_PROVISION_OUTPUT || DEFAULT_OUTPUT, envelope);
  return {
    output,
    version: envelope.version,
    algorithm: envelope.algorithm
  };
}

if (require.main === module) {
  try {
    const result = provision();
    process.stdout.write(JSON.stringify({
      artifact: path.basename(result.output),
      encrypted: true,
      algorithm: result.algorithm,
      version: result.version
    }) + '\n');
  } catch (error) {
    // Never print remote stderr/stdout or any registration material. The SSH
    // helper already converts failures into bounded phase summaries.
    console.error(error instanceof Error ? error.message : 'printer provisioning failed');
    process.exitCode = 1;
  }
}

module.exports = {
  AAD,
  DEFAULT_OUTPUT,
  ENVELOPE_VERSION,
  ORIGIN,
  REGISTRATION_NODE_SOURCE,
  REMOTE_NODE_SOURCE,
  buildRemoteCommand,
  createEnvelope,
  decodePublicKey,
  parseRemoteOutput,
  provision,
  validateProvisionInputs,
  validateEnvelope,
  validateRemoteConfig,
  writeEnvelope
};
