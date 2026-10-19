// Isolated actual-source React UI verification; all requests use local fixtures.
// Does not compile, replace, or publish an application build.
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const http = require('node:http');
const ts = require('typescript');
const sass = require('sass');
const { chromium, expect } = require('@playwright/test');
const output = path.resolve('release', `daily-backup-ui-${Date.now()}-${process.pid}`);
const source = file => ts.transpileModule(fs.readFileSync(file, 'utf8'), { compilerOptions: { target: ts.ScriptTarget.ES2020, module: ts.ModuleKind.CommonJS, jsx: ts.JsxEmit.ReactJSX } }).outputText;
const css = sass.compile('src/pages/backup/daily-status.module.scss').css;
const styles = Object.fromEntries([...css.matchAll(/[.]([a-zA-Z][a-zA-Z0-9_-]*)/g)].map(match => [match[1], match[1]]));
const component = source('src/pages/backup/daily-status.tsx');
const service = source('src/services/daily-backup.ts');
const react = fs.readFileSync(path.join(path.dirname(require.resolve('react/package.json')), 'umd/react.development.js'), 'utf8');
const reactDom = fs.readFileSync(path.join(path.dirname(require.resolve('react-dom/package.json')), 'umd/react-dom.development.js'), 'utf8');
const html = `<!doctype html><html lang="zh-CN"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><style>body{margin:0;background:#f5f7fb;font-family:sans-serif}.host{padding:32px;box-sizing:border-box;width:100%}${css}</style></head><body><main class="host" id="root"></main><script src="/react.js"></script><script src="/react-dom.js"></script><script src="/preview.js"></script></body></html>`;
const runtime = `
const modules = { react: React, 'react/jsx-runtime': { jsx:(type,props,key)=>React.createElement(type,{...props,key}), jsxs:(type,props,key)=>React.createElement(type,{...props,key}) }, '@tarojs/components':{View:'div',Text:'span',Button:'button'}, './daily-status.module.scss':{default:${JSON.stringify(styles)}} };
modules['./request'] = {request:async options=>{ const response=await fetch(options.url); const data=await response.json(); if(!response.ok) throw new Error(data.message || 'HTTP '+response.status); return data; }};
const serviceModule={exports:{}}; new Function('require','exports','module',${JSON.stringify(service)})(id=>modules[id],serviceModule.exports,serviceModule); modules['@/services/daily-backup']=serviceModule.exports;
const componentModule={exports:{}}; new Function('require','exports','module',${JSON.stringify(component)})(id=>modules[id],componentModule.exports,componentModule);
const root=ReactDOM.createRoot(document.getElementById('root')); const element=React.createElement(componentModule.exports.default); root.render(location.search.includes('strict')?React.createElement(React.StrictMode,null,element):element); window.unmountPanel=()=>root.unmount();
`;
const healthy = () => ({ enabled: true, active: true, timeZone: 'Asia/Shanghai', hour: 2, keepDays: 30, lastSuccessAt: '2026-10-18T18:00:00.000Z', lastAttemptAt: '2026-10-18T18:00:00.000Z', lastError: null, nextScheduledAt: '2026-10-19T18:00:00.000Z', nextRetryAt: null, running: false, location: 'server', verified: true });
const exportData = { exportedAt: healthy().lastSuccessAt, data: { products: [{ id: 3, name: '纸板测试' }], ledger_attachment_files: { proof: 'local-fixture-only' } } };
const server = http.createServer((req,res)=>{ const item=req.url==='/react.js'?react:req.url==='/react-dom.js'?reactDom:req.url==='/preview.js'?runtime:html; res.setHeader('Content-Type',req.url.endsWith('.js')?'text/javascript':'text/html; charset=utf-8'); res.end(item); });
async function main(){
  fs.mkdirSync(output,{recursive:true});
  await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));
  const base=`http://127.0.0.1:${server.address().port}`;
  const browser=await chromium.launch({headless:true});
  const results=[];
  try {
    for(const width of [320,390,736]) {
      const context=await browser.newContext({viewport:{width,height:900},timezoneId:'America/Los_Angeles',acceptDownloads:true});
      const page=await context.newPage(); const errors=[]; page.on('pageerror',e=>errors.push(e.message));
      let mode='healthy', statusCalls=0, latestCalls=0;
      await page.route('**/api/backup/daily/**',async route=>{
        const latest=route.request().url().endsWith('/latest'); if(latest) latestCalls+=1; else statusCalls+=1;
        if(mode==='slow') await new Promise(resolve=>setTimeout(resolve,120));
        if(mode==='unavailable'||mode==='download-failure') return route.fulfill({status:503,contentType:'application/json',body:JSON.stringify({message:'测试：服务器暂时未连接'})});
        let data=latest?exportData:healthy();
        if(!latest&&mode==='malformed') data={};
        if(!latest&&mode==='disabled') data={...healthy(),enabled:false,active:false,lastSuccessAt:null,verified:false};
        if(!latest&&mode==='inactive') data={...healthy(),active:false};
        if(!latest&&mode==='first') data={...healthy(),lastSuccessAt:null,lastAttemptAt:null,verified:false};
        if(!latest&&mode==='failed') data={...healthy(),lastError:'备份校验失败',nextRetryAt:'2026-10-19T03:00:00.000Z'};
        return route.fulfill({status:200,contentType:'application/json',body:JSON.stringify(data)});
      });
      await page.goto(base);
      await expect(page.getByText('每日备份正常',{exact:true})).toBeVisible();
      await expect(page.getByText('北京时间 02:00',{exact:true})).toBeVisible();
      await expect(page.getByText('最近 30 份 · 存在服务器',{exact:true})).toBeVisible();
      await expect(page.getByText('2026-10-19 02:00:00（北京时间）',{exact:true}).first()).toBeVisible();
      assert.equal(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth),true,`no overflow ${width}`);
      await page.screenshot({path:path.join(output,`daily-status-${width}.png`),fullPage:true});
      const before=statusCalls;mode='slow';
      await page.getByRole('button',{name:'刷新状态',exact:true}).evaluate(button=>{button.click();button.click();});
      await expect(page.getByRole('button',{name:'确认中…',exact:true})).toBeDisabled();
      await expect(page.getByText('每日备份正常',{exact:true})).toBeVisible();
      assert.equal(statusCalls,before+1,'double refresh has one request');mode='healthy';
      const downloadPromise=page.waitForEvent('download');
      await page.getByRole('button',{name:'下载最近备份',exact:true}).evaluate(button=>{button.click();button.click();});
      const download=await downloadPromise; const filename=path.join(output,`download-${width}.json`); await download.saveAs(filename);
      assert.deepEqual(JSON.parse(fs.readFileSync(filename,'utf8')),exportData);assert.equal(latestCalls,1);
      await expect(page.getByText(/已发起下载/)).toBeVisible();
      mode='download-failure';await page.getByRole('button',{name:'下载最近备份',exact:true}).click();
      await expect(page.getByText('下载失败：测试：服务器暂时未连接',{exact:true})).toBeVisible();
      assert.equal(await page.getByText('下载失败：测试：服务器暂时未连接',{exact:true}).getAttribute('aria-live'),'polite');
      for(const [next,label] of [['disabled','每日备份未启用'],['inactive','定时任务未运行'],['first','定时已启用 · 等待首次备份'],['failed','最近一次备份失败'],['unavailable','未连接 · 备份状态未确认'],['malformed','未连接 · 备份状态未确认']]) {
        mode=next;await page.getByRole('button',{name:'刷新状态',exact:true}).click();
        await expect(page.getByText(label,{exact:true})).toBeVisible();
        if(['disabled','first','unavailable','malformed'].includes(next)) await expect(page.getByRole('button',{name:'下载最近备份',exact:true})).toBeDisabled();
        if(next==='failed') {await expect(page.getByText('2026-10-19 11:00:00（北京时间）',{exact:true})).toBeVisible();await page.screenshot({path:path.join(output,`daily-failed-${width}.png`),fullPage:true});}
        assert.equal(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth),true,`no overflow ${width} ${next}`);
      }
      assert.deepEqual(errors,[]);results.push({width,ok:true,statusCalls,latestCalls});await context.close();
    }
    // StrictMode replays effects. Its older request must not overwrite the new response.
    const page=await browser.newPage({viewport:{width:320,height:740}});let calls=0;
    await page.route('**/api/backup/daily/status',async route=>{calls+=1;const first=calls===1;if(first)await new Promise(resolve=>setTimeout(resolve,250));await route.fulfill({status:200,contentType:'application/json',body:JSON.stringify(first?{...healthy(),enabled:false,active:false}:healthy())});});
    await page.goto(base+'?strict');await expect(page.getByText('每日备份正常',{exact:true})).toBeVisible();await page.waitForTimeout(350);await expect(page.getByText('每日备份正常',{exact:true})).toBeVisible();assert.equal(calls,2);
    results.push({strictModeStaleRequestIgnored:true});
    fs.writeFileSync(path.join(output,'verification.json'),JSON.stringify({ok:true,results},null,2));
    process.stdout.write(JSON.stringify({ok:true,output,results},null,2)+'\n');
  } finally {await browser.close();await new Promise(resolve=>server.close(resolve));}
}
main().catch(error=>{console.error(error);server.close();process.exitCode=1;});
