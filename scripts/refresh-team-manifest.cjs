const fs = require('node:fs/promises');
(async()=>{
  const current=await (await fetch('https://youxishen.online/appupdate/manifest.json')).json();
  const manifest={...current,version:String(BigInt(current.version)+1n),publishedAt:new Date().toISOString(),releaseNotes:'共享仓库：成员权限、同步、审计和稳定登录'};
  await fs.writeFile('release/team-manifest.json',JSON.stringify(manifest,null,2));
  console.log('Release '+manifest.version);
})().catch(e=>{console.error(e.message);process.exitCode=1});
