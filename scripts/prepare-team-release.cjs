const fs = require('node:fs/promises');
const { randomBytes, createHash } = require('node:crypto');
const { bootstrap } = require('../backend/team');
(async () => {
  const previous = await (await fetch('https://youxishen.online/appupdate/manifest.json')).json();
  const version = String(BigInt(previous.version) + 1n);
  await fs.writeFile('release/team-manifest.json', JSON.stringify({version, url:'www.zip', publishedAt:new Date().toISOString(), releaseNotes:'共享仓库：登录、成员权限、自动刷新、操作记录和防重复提交', forceUpdate:false, minNativeVersion:null},null,2));
  const password = randomBytes(24).toString('base64url');
  await bootstrap('release/team-accounts.json',password);
  await fs.writeFile('release/team-owner-access.txt', `Warehouse admin\nURL: https://youxishen.online/workspace/\nUsername: admin\nPassword: ${password}\nChange the password after first login. Do not send this file to employees.\n`,{flag:'wx',mode:0o600});
  const artifact = await fs.readFile('release/shuguang-team.ipa');
  console.log(JSON.stringify({version,size:artifact.length,sha256:createHash('sha256').update(artifact).digest('hex')}));
})().catch(e=>{console.error(e.message);process.exitCode=1});
