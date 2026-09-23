const fs = require('fs');
const path = require('path');
const { Client } = require('ssh2');

const host = process.env.HOTUPDATE_HOST;
const username = process.env.HOTUPDATE_USER;
const password = process.env.HOTUPDATE_PASSWORD;
const port = Number(process.env.HOTUPDATE_PORT || 22);
const remoteDir = process.env.HOTUPDATE_DIR || '/opt/shuguang/public/appupdate';
const root = path.resolve(__dirname, '..');
const localZip = path.join(root, 'deploy', 'hotupdate', 'bundle.zip');
const localManifest = path.join(root, 'deploy', 'hotupdate', 'manifest.json');
if (!host || !username || !password) throw new Error('HOTUPDATE_HOST, HOTUPDATE_USER and HOTUPDATE_PASSWORD are required');

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
}).on('error', error => { console.error(error.message); process.exitCode = 1; });
conn.connect({ host, port, username, password, readyTimeout: 15000 });
