const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const { execFileSync } = require('node:child_process');
const root = path.resolve(__dirname, '..');
function validateLocalRelease(zipFile, manifestFile) {
  if (!zipFile || !manifestFile) throw new Error('Explicit release paths are required; shared default archives cannot be published');
  const bytes = fs.readFileSync(zipFile);
  const manifest = JSON.parse(fs.readFileSync(manifestFile, 'utf8').replace(/^\ufeff/, ''));
  const digest = crypto.createHash('sha256').update(bytes).digest('hex');
  if (!/^(?:\d{14}|\d+\.\d+\.\d+(?:[-+][0-9A-Za-z.-]+)?)$/.test(manifest.version || '')) throw new Error('hot-update manifest version is invalid');
  if (manifest.url !== 'www.zip') throw new Error('hot-update manifest url must be www.zip');
  if (manifest.size !== bytes.length || manifest.sha256 !== digest || manifest.integrity?.algorithm !== 'sha256' || manifest.integrity.value !== digest) throw new Error('hot-update manifest integrity does not match archive');
  return { manifest, size: bytes.length, sha256: digest };
}
function shellQuote(value) { return "'" + String(value).replaceAll("'", "'\\''") + "'"; }
function remoteCommand(command, args, options = {}) {
  const password = process.env.HOTUPDATE_PASSWORD;
  return execFileSync(password ? 'sshpass' : command, password ? ['-e', command, ...args] : args, {
    ...options, env: { ...process.env, ...(password ? { SSHPASS: password } : {}) }, encoding: 'utf8'
  });
}
function connection() {
  const host = process.env.HOTUPDATE_HOST, user = process.env.HOTUPDATE_USER;
  if (!/^[A-Za-z0-9.-]+$/.test(host || '') || !/^[A-Za-z0-9_-]+$/.test(user || '')) throw new Error('HOTUPDATE_HOST and HOTUPDATE_USER are required');
  const port = Number(process.env.HOTUPDATE_PORT || 22);
  if (!Number.isInteger(port) || port < 1 || port > 65535) throw new Error('Invalid SSH port');
  const directory = process.env.HOTUPDATE_DIR || '/opt/shuguang/public/appupdate';
  if (!/^\/[A-Za-z0-9_/-]+$/.test(directory)) throw new Error('Invalid update directory');
  return { target: `${user}@${host}`, port: String(port), directory };
}
function ssh(command, input) {
  const c = connection();
  return remoteCommand('ssh', ['-p', c.port, '-o', 'ConnectTimeout=15', c.target, command], { input, maxBuffer: 8 * 1024 * 1024 });
}
function captureBaseline(output) {
  const c = connection();
  const raw = ssh(`if [ -f ${shellQuote(c.directory + '/manifest.json')} ]; then cat ${shellQuote(c.directory + '/manifest.json')}; fi`);
  if (raw.trim()) JSON.parse(raw.replace(/^\ufeff/, ''));
  fs.writeFileSync(output, raw);
}
function upload() {
  const zip = process.env.HOTUPDATE_LOCAL_ZIP, manifestPath = process.env.HOTUPDATE_LOCAL_MANIFEST;
  const { manifest } = validateLocalRelease(zip, manifestPath);
  if (!/^[a-f0-9]{40,64}$/.test(manifest.commit || '') || !Array.isArray(manifest.ancestors) || !Object.hasOwn(manifest, 'baseManifestSha256')) throw new Error('Missing release provenance; use the unified publish workflow');
  const head = execFileSync('git', ['rev-parse', 'HEAD'], { cwd: root, encoding: 'utf8' }).trim();
  const dirty = execFileSync('git', ['status', '--porcelain', '--untracked-files=normal', '--', 'src', 'config', 'prototypes', 'scripts', 'package.json', 'package-lock.json'], { cwd: root, encoding: 'utf8' }).trim();
  if (dirty) throw new Error('Release source has uncommitted changes; publish committed main source through CI');
  const latest = execFileSync('git', ['ls-remote', 'origin', 'refs/heads/main'], { cwd: root, encoding: 'utf8' }).trim().split(/\s+/)[0];
  if (manifest.commit !== head || head !== latest) throw new Error('Source is no longer the latest main commit; rebuild through the publish workflow');
  const c = connection(), staging = c.directory + '/.incoming-' + crypto.randomUUID();
  ssh(`mkdir -p ${shellQuote(staging)}`);
  try {
    for (const [source, name] of [[zip, 'www.zip'], [manifestPath, 'manifest.json']]) remoteCommand('scp', ['-P', c.port, path.resolve(source), `${c.target}:${staging}/${name}`]);
    const result = ssh(`python3 - ${shellQuote(c.directory)} ${shellQuote(staging)}`, fs.readFileSync(path.join(__dirname, 'publish-hotupdate.py')));
    process.stdout.write(result);
    return result;
  } finally { ssh(`rm -f ${shellQuote(staging + '/www.zip')} ${shellQuote(staging + '/manifest.json')}; rmdir ${shellQuote(staging)}`); }
}
if (require.main === module) {
  try {
    if (process.argv[2] === '--capture-baseline' && process.argv[3]) captureBaseline(process.argv[3]);
    else upload();
  } catch (error) { console.error(error.message); process.exitCode = 1; }
}
module.exports = { validateLocalRelease, upload, captureBaseline };
