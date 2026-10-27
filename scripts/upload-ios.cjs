const { execFile, execFileSync } = require('node:child_process');
const crypto = require('node:crypto');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { promisify } = require('node:util');
const { prepareDownload } = require('./prepare-download.cjs');

const root = path.resolve(__dirname, '..');
const execFileAsync = promisify(execFile);
const sshOptions = [
  '-o', 'ConnectTimeout=15', '-o', 'ServerAliveInterval=15', '-o', 'ServerAliveCountMax=4',
  '-o', 'StrictHostKeyChecking=yes',
];

function required(env, name) {
  if (!env[name]) throw new Error(name + ' is required for iOS publication');
  return env[name];
}

function uniqueStage(env, nonce = crypto.randomUUID()) {
  const run = required(env, 'GITHUB_RUN_ID');
  const attempt = env.GITHUB_RUN_ATTEMPT || '1';
  if (!/^\d+$/.test(run) || !/^\d+$/.test(attempt) || !/^[a-f0-9-]{36}$/.test(nonce)) {
    throw new Error('Invalid iOS release staging identity');
  }
  return `/tmp/warehouse-ios-${run}-${attempt}-${nonce}`;
}

function splitFile(filePath, outputDir, partCount = 8) {
  if (!Number.isInteger(partCount) || partCount < 2 || partCount > 16) {
    throw new Error('IPA part count must be between 2 and 16');
  }
  const data = fs.readFileSync(filePath);
  if (data.length < partCount) throw new Error('IPA is too small to split');
  const partSize = Math.ceil(data.length / partCount);
  fs.mkdirSync(outputDir, { recursive: true });
  const parts = [];
  for (let index = 0, offset = 0; offset < data.length; index++, offset += partSize) {
    const name = `shuguang.part.${String(index).padStart(2, '0')}`;
    const filename = path.join(outputDir, name);
    fs.writeFileSync(filename, data.subarray(offset, Math.min(offset + partSize, data.length)));
    parts.push(filename);
  }
  return parts;
}

function verifyPrepared(metadata, env) {
  if (!metadata || metadata.build !== env.GITHUB_RUN_NUMBER) throw new Error('IPA build does not match workflow run');
  if (metadata.sourceCommit !== env.GITHUB_SHA) throw new Error('IPA source commit does not match workflow checkout');
  if (!/^\/download\/shuguang-[A-Za-z0-9._-]+\.ipa$/.test(metadata.url || '')) throw new Error('IPA URL is not versioned');
  if (!/^[a-f0-9]{64}$/.test(metadata.sha256 || '') || !Number.isSafeInteger(metadata.sizeBytes)) {
    throw new Error('IPA integrity metadata is invalid');
  }
}

function authEnv(env) {
  const target = required(env, 'SERVER_USER') + '@' + required(env, 'SERVER_HOST');
  const port = env.SERVER_PORT || '22';
  if (!/^\d+$/.test(port) || !/^[A-Za-z0-9._-]+$/.test(env.SERVER_HOST) || !/^[A-Za-z0-9._-]+$/.test(env.SERVER_USER)) {
    throw new Error('Invalid iOS publication target');
  }
  if (env.SSH_PRIVATE_KEY) {
    const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'warehouse-ios-key-'));
    const key = path.join(directory, 'id');
    fs.writeFileSync(key, env.SSH_PRIVATE_KEY + '\n', { mode: 0o600 });
    return { target, port, key, mode: 'key' };
  }
  if (env.SSH_PASS) {
    try { execFileSync('sh', ['-c', 'command -v sshpass >/dev/null'], { timeout: 10000 }); }
    catch { throw new Error('Password authentication requires sshpass; configure SSH_PRIVATE_KEY'); }
    return { target, port, mode: 'password', env: { ...env, SSHPASS: env.SSH_PASS } };
  }
  throw new Error('No iOS publication SSH credential is configured');
}

function transportArgs(auth, base, input) {
  const args = auth.mode === 'password' ? ['-e', base, ...input] : [...input];
  return { command: auth.mode === 'password' ? 'sshpass' : base, args };
}

async function runStep(name, operation) {
  const started = Date.now();
  console.log('iOS publish: ' + name);
  const result = await operation();
  console.log(`iOS publish: ${name} completed in ${Date.now() - started}ms`);
  return result;
}

function execute(auth, base, args, timeout, extraEnv = {}) {
  const transport = transportArgs(auth, base, args);
  return execFileSync(transport.command, transport.args, {
    cwd: root, encoding: 'utf8', timeout, stdio: ['pipe', 'pipe', 'pipe'],
    env: { ...process.env, ...(auth.env || {}), ...extraEnv },
  });
}

async function executeAsync(auth, base, args, timeout) {
  const transport = transportArgs(auth, base, args);
  const result = await execFileAsync(transport.command, transport.args, {
    cwd: root, encoding: 'utf8', timeout, maxBuffer: 1024 * 1024,
    env: { ...process.env, ...(auth.env || {}) },
  });
  return result.stdout;
}

async function uploadParts(auth, scpCommon, target, stage, parts, timeout) {
  const results = await Promise.allSettled(parts.map(filename => executeAsync(auth, 'scp', [
    ...scpCommon, filename, target + ':' + stage + '/' + path.basename(filename),
  ], timeout)));
  const failed = results.filter(result => result.status === 'rejected');
  if (failed.length) {
    const reasons = failed.map(result => result.reason instanceof Error ? result.reason.message : String(result.reason));
    throw new Error(`${failed.length} of ${parts.length} IPA parts failed: ${reasons.slice(0, 2).join('; ')}`);
  }
}

async function cancelSuperseded(runId, runNumber, env, fetchImpl) {
  if (env.GITHUB_ACTIONS !== 'true') return [];
  const token = required(env, 'GH_TOKEN');
  const repo = required(env, 'GITHUB_REPOSITORY');
  const branch = env.GITHUB_REF_NAME || 'main';
  const headers = { Authorization: 'Bearer ' + token, Accept: 'application/vnd.github+json' };
  const response = await fetchImpl(`https://api.github.com/repos/${repo}/actions/workflows/build-ios.yml/runs?branch=${encodeURIComponent(branch)}&per_page=100`, { headers });
  if (!response.ok) throw new Error('Unable to list superseded iOS runs');
  const body = await response.json();
  const stale = (body.workflow_runs || []).filter(run => run.id !== Number(runId)
    && run.run_number < Number(runNumber) && ['queued', 'in_progress'].includes(run.status));
  for (const run of stale) {
    const cancelled = await fetchImpl(`https://api.github.com/repos/${repo}/actions/runs/${run.id}/cancel`, { method: 'POST', headers });
    if (!cancelled.ok && cancelled.status !== 409) throw new Error('Unable to cancel superseded iOS run ' + run.id);
  }
  return stale.map(run => run.id);
}

async function upload(env = process.env, dependencies = {}) {
  const prepare = dependencies.prepareDownload || prepareDownload;
  const fetchImpl = dependencies.fetch || fetch;
  const nonce = dependencies.nonce || crypto.randomUUID();
  const stage = uniqueStage(env, nonce);
  await cancelSuperseded(env.GITHUB_RUN_ID, env.GITHUB_RUN_NUMBER, env, fetchImpl);
  const previousSha = env.GITHUB_SHA;
  const output = path.join(root, 'release', 'ios-download-' + env.GITHUB_RUN_ID + '-' + (env.GITHUB_RUN_ATTEMPT || '1'));
  const metadata = await prepare(path.join(root, 'ios/App/shuguang.ipa'), output);
  if (previousSha !== env.GITHUB_SHA) throw new Error('Workflow source changed during iOS publication');
  verifyPrepared(metadata, env);
  const parts = splitFile(path.join(root, 'ios/App/shuguang.ipa'), path.join(output, 'parts'), 8);

  const auth = authEnv(env);
  const knownHosts = auth.key ? auth.key + '.known_hosts' : path.join(os.tmpdir(), 'warehouse-ios-known-hosts');
  const scan = execFileSync('ssh-keyscan', ['-T', '15', '-H', env.SERVER_HOST], { encoding: 'utf8', timeout: 30000 });
  if (!scan.trim()) throw new Error('SSH host key scan returned no keys');
  fs.writeFileSync(knownHosts, scan, { mode: 0o600 });
  const common = [...sshOptions, ...(auth.key ? ['-i', auth.key, '-o', 'BatchMode=yes'] : []), '-o', 'UserKnownHostsFile=' + knownHosts];
  const scpCommon = ['-O', '-P', auth.port, ...common];
  const sshCommon = ['-p', auth.port, ...common];

  await runStep('create remote staging directory', () => execute(auth, 'ssh', [...sshCommon, auth.target, 'mkdir -p ' + stage], 30000));
  await runStep('upload metadata', () => execute(auth, 'scp', [...scpCommon,
    path.join(output, 'ipa.json'), path.join(output, 'source.json'), path.join(output, 'index.html'), path.join(output, 'app-icon.png'),
    path.join(root, 'scripts/publish-ios-files.sh'), auth.target + ':' + stage + '/'], 120000));
  await runStep('upload IPA parts', () => uploadParts(auth, scpCommon, auth.target, stage, parts, 900000));
  await runStep('assemble IPA', () => execute(auth, 'ssh', [...sshCommon, auth.target,
    `cd ${stage} && cat shuguang.part.* > shuguang.ipa && rm -f shuguang.part.*`], 120000));
  await runStep('publish atomically', () => execute(auth, 'ssh', [...sshCommon, auth.target,
    `sudo -n sh ${stage}/publish-ios-files.sh ${stage}`], 180000));
  await runStep('remove staging directory', () => execute(auth, 'ssh', [...sshCommon, auth.target, `rm -rf ${stage}`], 30000));
  return {
    stage, build: metadata.build, version: metadata.version, sourceCommit: metadata.sourceCommit,
    transfer: `parallel-scp-${parts.length}`,
  };
}

if (require.main === module) {
  upload().then(result => console.log(JSON.stringify(result)))
    .catch(error => { console.error('iOS publication failed: ' + error.message); process.exitCode = 1; });
}

module.exports = {
  authEnv, cancelSuperseded, splitFile, uniqueStage, upload, verifyPrepared,
};
