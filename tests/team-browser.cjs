const { chromium, webkit } = require(require('node:path').join(process.env.TEMP,'warehouse-release-tools/node_modules/@playwright/test'));
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
(async()=>{
  const { server } = await require('../scripts/team-preview.cjs')();
  const base='http://127.0.0.1:4186';
  const browser=await (process.env.TEAM_BROWSER==='webkit'?webkit:chromium).launch();
  try {
    const errors=[];
    async function page(viewport) {
      const context=await browser.newContext({viewport});
      await context.route('https://youxishen.online/**',async route=>{
        const url=new URL(route.request().url());
        const result=await route.fetch({url:base+url.pathname+url.search});
        await route.fulfill({response:result,headers:{...result.headers(),'access-control-allow-origin':'*','access-control-expose-headers':'X-Warehouse-Revision'}});
      });
      const p=await context.newPage();p.on('pageerror',e=>errors.push(e.message));return p;
    }
    const a=await page({width:390,height:844});
    await a.goto(base);await a.locator('.team-login input').first().waitFor();await a.screenshot({path:'release/team-login.png',fullPage:true});await a.locator('.team-login input').nth(0).fill('admin');await a.locator('.team-login input').nth(1).fill('Local-preview-password!');await a.getByText('登录',{exact:true}).click();await a.locator('.team-login').waitFor({state:'detached'});
    await a.getByText('曙光库存',{exact:true}).first().waitFor();
    await a.screenshot({path:'release/team-home.png',fullPage:true});
    console.log('Login and homepage rendered',a.url());
    await a.getByText('商品管理',{exact:true}).first().click();
    const b=await page({width:1280,height:900});
    await b.goto(base);await b.locator('.team-login input').nth(0).fill('admin');await b.locator('.team-login input').nth(1).fill('Local-preview-password!');await b.getByText('登录',{exact:true}).click();await b.locator('.team-login').waitFor({state:'detached'});
    await b.getByText('新增商品',{exact:true}).first().click();
    await b.getByPlaceholder('请输入商品名称').locator('input').fill('Shared carton');
    await b.getByText('保存',{exact:true}).click();
    await a.getByText('Shared carton',{exact:true}).last().waitFor({timeout:12000});
    await a.screenshot({path:'release/team-shared-products.png',fullPage:true});
    await a.goto(base+'/#/pages/team/index');
    await a.getByText('新增成员',{exact:true}).waitFor();
    await a.screenshot({path:'release/team-members.png',fullPage:true});
    assert(await a.evaluate(()=>document.documentElement.scrollWidth<=innerWidth));
    assert.equal(errors.length,0,errors.join('\n'));
    console.log('Two sessions: product shared, no JS errors');
  } finally {await browser.close();await new Promise(r=>server.close(r));}
})().catch(e=>{console.error(e);process.exitCode=1});
