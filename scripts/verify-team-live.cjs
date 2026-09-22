const fs = require('node:fs/promises');
const path = require('node:path');
const assert = require('node:assert/strict');
const { createHash } = require('node:crypto');
const { webkit } = require(path.join(process.env.TEMP,'warehouse-release-tools/node_modules/@playwright/test'));
(async()=>{
  const info=await fs.readFile('release/team-owner-access.txt','utf8');
  const password=info.split('\n').find(line=>line.startsWith('Password: ')).slice(10);
  const origin='https://youxishen.online';
  assert.equal((await fetch(origin+'/api/products')).status,401);
  const login=await (await fetch(origin+'/api/auth/login',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({username:'admin',password})})).json();
  assert(login.success);const token=login.data.token;
  for(const endpoint of ['/products','/customers','/suppliers','/transactions','/orders','/ledger','/team','/audit','/sync']){
    const r=await fetch(origin+'/api'+endpoint,{headers:{Authorization:`Bearer ${token}`}});assert.equal(r.status,200,endpoint);
  }
  const metadata=await (await fetch(origin+'/download/ipa.json')).json();
  assert.equal(metadata.build,'11');assert.equal(metadata.version,'1.2.0');
  const ipa=Buffer.from(await (await fetch('http://152.136.100.200/download/shuguang.ipa')).arrayBuffer());
  assert.equal(createHash('sha256').update(ipa).digest('hex'),metadata.sha256);
  const manifest=await (await fetch(origin+'/appupdate/manifest.json')).json();
  assert.equal(manifest.version,JSON.parse(await fs.readFile('release/team-manifest.json','utf8')).version);
  const browser=await webkit.launch();
  try {
    const page=await browser.newPage({viewport:{width:390,height:844},isMobile:true,hasTouch:true});
    const errors=[];page.on('pageerror',e=>errors.push(e.message));
    await page.goto(origin+'/workspace/');
    await page.locator('.team-login input').nth(0).fill('admin');await page.locator('.team-login input').nth(1).fill(password);
    await page.getByText('登录',{exact:true}).click();await page.locator('.team-login').waitFor({state:'detached'});
    await page.getByText('我的',{exact:true}).last().click();
    await page.getByText('团队与账号',{exact:true}).click();await page.locator('.team-member').first().waitFor();
    await page.screenshot({path:'release/team-live.png',fullPage:true});
    assert.equal(errors.length,0,errors.join('\n'));
    await page.getByText('退出登录',{exact:true}).click();await page.locator('.team-login').waitFor();
    console.log('Public HTTPS: login, team UI, protected reads and logout passed. IP IPA SHA-256 matched; Build 11 verified.');
  } finally {await browser.close();}
  await fetch(origin+'/api/auth/logout',{method:'POST',headers:{Authorization:`Bearer ${token}`}});
})().catch(e=>{console.error(e.message);process.exitCode=1});
