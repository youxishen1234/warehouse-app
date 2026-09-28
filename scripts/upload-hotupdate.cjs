const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const host = process.env.HOTUPDATE_HOST;
const username = process.env.HOTUPDATE_USER;
const password = process.env.HOTUPDATE_PASSWORD;
const port = Number(process.env.HOTUPDATE_PORT || 22);
const remoteDir = process.env.HOTUPDATE_DIR || '/opt/shuguang/public/appupdate';
const root = path.resolve(__dirname, '..');
const localZip = process.env.HOTUPDATE_LOCAL_ZIP || path.join(root, 'deploy', 'hotupdate', 'bundle.zip');
const localManifest = process.env.HOTUPDATE_LOCAL_MANIFEST || path.join(root, 'deploy', 'hotupdate', 'manifest.json');

function validateLocalRelease(zipFile = localZip, manifestFile = localManifest) {
  if (!fs.existsSync(zipFile) || !fs.statSync(zipFile).isFile()) throw new Error(`hot-update archive does not exist: ${zipFile}`);
  if (!fs.existsSync(manifestFile) || !fs.statSync(manifestFile).isFile()) throw new Error(`hot-update manifest does not exist: ${manifestFile}`);
  let manifest;
  try { manifest = JSON.parse(fs.readFileSync(manifestFile, 'utf8').replace(/^\ufeff/, '')); }
  catch (error) { throw new Error(`hot-update manifest is invalid JSON: ${error.message}`); }
  const versionPattern = /^(?:\d{14}|\d+\.\d+\.\d+(?:[-+][0-9A-Za-z.-]+)?)$/;
  const digestPattern = /^[a-f0-9]{64}$/i;
  if (!manifest || typeof manifest !== 'object' || !versionPattern.test(String(manifest.version || ''))) throw new Error('hot-update manifest version is invalid');
  if (manifest.url !== 'www.zip') throw new Error('hot-update manifest url must be www.zip');
  const bytes = fs.readFileSync(zipFile);
  const digest = crypto.createHash('sha256').update(bytes).digest('hex');
  if (manifest.size !== bytes.length) throw new Error('hot-update manifest size does not match archive');
  if (!digestPattern.test(String(manifest.sha256 || '')) || manifest.sha256.toLowerCase() !== digest) throw new Error('hot-update manifest sha256 does not match archive');
  if (!manifest.integrity || manifest.integrity.algorithm !== 'sha256' || String(manifest.integrity.value).toLowerCase() !== digest) throw new Error('hot-update manifest integrity does not match archive');
  return { manifest, size: bytes.length, sha256: digest };
}

async function upload() {
  validateLocalRelease();
  if (!host || !username || !password) throw new Error('HOTUPDATE_HOST, HOTUPDATE_USER and HOTUPDATE_PASSWORD are required');
  const { Client } = require('ssh2');

  const conn = new Client();
const exec = (command) => new Promise((resolve, reject) => conn.exec(command, (err, stream) => {
  if (err) return reject(err);
  let out = '', error = '';
  stream.on('data', data => { out += data; });
  stream.stderr.on('data', data => { error += data; });
  stream.on('close', code => code === 0 ? resolve(out) : reject(new Error(error || `remote command failed: ${code}`)));
}));
const put = (source, target) => new Promise((resolve, reject) => conn.sftp((err, sftp) => {
  if (err) return reject(err);
  sftp.fastPut(source, target, error => error ? reject(error) : resolve());
}));

  conn.on('ready', async () => {
  try {
    const stamp = Date.now();
    const zipTmp = `${remoteDir}/www.zip.${stamp}.new`;
    const manifestTmp = `${remoteDir}/manifest.json.${stamp}.new`;
    await exec(`mkdir -p '${remoteDir}'`);
    await put(localZip, zipTmp);
    await put(localManifest, manifestTmp);
    await exec(`mv '${zipTmp}' '${remoteDir}/www.zip' && mv '${manifestTmp}' '${remoteDir}/manifest.json'`);
    const result = await exec(`cat '${remoteDir}/manifest.json' && stat -c '%n %s' '${remoteDir}/www.zip'`);
    process.stdout.write(result);
    conn.end();
  } catch (error) {
    conn.end();
    console.error(error.message);
    process.exitCode = 1;
  }
  }).on('error', error => { throw error; });
  conn.connect({ host, port, username, password, readyTimeout: 15000 });
}

if (require.main === module) upload().catch(error => { console.error(error.message); process.exitCode = 1; });

module.exports = { validateLocalRelease, upload };
