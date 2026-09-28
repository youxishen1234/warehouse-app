'use strict';
const fs = require('node:fs');
const path = require('node:path');
const express = require('../backend/node_modules/express');
const { chromium, webkit } = require('playwright');
const assert = require('node:assert/strict');
const root = path.resolve(__dirname, '..');
const output = path.join(root, 'release/stage1/h5');
async function main(){
 fs.mkdirSync(output,{recursive:true});
 const app=express(); app.use(express.static(path.join(root,'prototypes/h5')));
 const server=app.listen(0,'127.0.0.1');await new Promise(r=>server.once('listening',r));
 const origin='http://127.0.0.1:'+server.address().port;
 const results=[];
 try{for(const [engineName,engine] of [['chromium',chromium],['webkit',webkit]]){
  const browser=await engine.launch();
  try{for(const width of [360,390,430,1280]){
   const page=await browser.newPage({viewport:{width,height:900},reducedMotion:'reduce'});
   const errors=[];page.on('pageerror',e=>errors.push(e.message));
   const external=[];await page.route('**/*',route=>{if(new URL(route.request().url()).origin!==origin){external.push(route.request().url());return route.abort()}return route.continue()});
   for(const route of ['home','inbound','outbound','mine']){
    for(const state of ['normal','loading','empty','error']){
     await page.goto(origin+'/?state='+state+'#'+route);
     const layout=await page.evaluate(()=>{const box=document.querySelector('.app').getBoundingClientRect();return {viewport:innerWidth,document:document.documentElement.scrollWidth,width:box.width,left:box.left}});
     assert(layout.document<=width,'horizontal overflow');assert(layout.width<=496,'desktop max-width');
     if(width===1280)assert.equal(layout.left,392);
     const screenshot=engineName+'-'+route+'-'+state+'-'+width+'.png';
     await page.screenshot({path:path.join(output,screenshot),fullPage:true});
     results.push({engine:engineName,route,state,width,layout,screenshot});
    }
   }
   await page.goto(origin+'/#inbound');
   await page.locator('[data-add-line]').click();assert.equal(await page.locator('.purchase-line').count(),2);
   assert.equal(await page.locator('#fixed-total').innerText(),'¥2,200.00');
   await page.locator('[data-delete-line]').last().click();assert.equal(await page.locator('.purchase-line').count(),2);
   await page.locator('#close-dialog').click();assert.equal(await page.locator('.purchase-line').count(),2);
   await page.locator('[data-delete-line]').last().click();await page.locator('#confirm-dialog').click();assert.equal(await page.locator('.purchase-line').count(),1);
   await page.locator('[data-spec]').fill('1200×800 / B');assert.equal(await page.locator('[data-area]').innerText(),'面积 1,920.00 m²');
   await page.locator('[data-spec]').fill('无效规格');await page.locator('[data-submit]').click();assert.equal(await page.locator('[data-spec]').getAttribute('aria-invalid'),'true');
   await page.locator('[data-spec]').fill('1550×705 / A');
   await page.locator('[data-submit]').click();assert(await page.locator('[data-submit]').isDisabled());
   await page.locator('#toast').waitFor({state:'visible'});
   await page.goto(origin+'/#outbound');await page.locator('[data-step="1"]').click();assert.equal(await page.locator('#sale-total').innerText(),'¥1,152.96');
   await page.locator('#sale-quantity').fill('-1');await page.locator('[data-submit]').click();assert.equal(await page.locator('#sale-quantity').getAttribute('aria-invalid'),'true');
   await page.goto(origin+'/#mine');await page.locator('[data-preview]').first().click();assert(await page.locator('dialog').isVisible());await page.locator('#close-dialog').click();
   await page.goto(origin+'/#home');const previous=await page.locator('.series-b').getAttribute('d');await page.locator('[data-period="30"]').click();assert.notEqual(await page.locator('.series-b').getAttribute('d'),previous);assert.match(await page.locator('.chart').getAttribute('aria-label'),/三十天/);assert.equal(await page.getByRole('heading',{name:'库存预警',exact:true}).count(),1);
   assert.deepEqual(errors,[]);assert.deepEqual(external,[]);await page.close();
  }}finally{await browser.close()}
 }}finally{server.closeAllConnections();await new Promise(r=>server.close(r));fs.writeFileSync(path.join(output,'results.json'),JSON.stringify(results,null,2))}
 console.log(JSON.stringify({screenshots:results.length,engines:['chromium','webkit'],widths:[360,390,430,1280],states:['normal','loading','empty','error'],interactions:'passed',externalRequests:0},null,2));
}
main().catch(e=>{console.error(e);process.exitCode=1});
