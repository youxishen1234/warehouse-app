const assert=require('node:assert/strict');
const fs=require('node:fs');
const os=require('node:os');
const path=require('node:path');
const crypto=require('node:crypto');
const {chromium,expect}=require('@playwright/test');
async function main(){
 const dir=fs.mkdtempSync(path.join(os.tmpdir(),'customer-original-4k-'));
 process.env.WAREHOUSE_DATA_FILE=path.join(dir,'data.json');
 process.env.WAREHOUSE_BACKUP_DIR=path.join(dir,'backups');
 process.env.WAREHOUSE_WEB_ROOT=path.resolve(process.env.CUSTOMER_PHOTO_WEB_DIR||'dist');
 process.env.WAREHOUSE_ACCOUNTS_FILE=path.join(dir,'accounts.json');
 process.env.WAREHOUSE_DIMENSIONS_FILE=path.join(dir,'dimensions.json');
 fs.writeFileSync(process.env.WAREHOUSE_DATA_FILE,JSON.stringify({products:[],customers:[],suppliers:[],transactions:[],ledger:[]}));
 fs.writeFileSync(process.env.WAREHOUSE_ACCOUNTS_FILE,JSON.stringify({users:[{id:'photo-test-admin',username:'photo-test',role:'admin',disabled:false}],events:[]}));
 const db=require('../backend/db');const customer=db.addCustomer({name:'4K原图测试客户'});
 const originalFinancial=JSON.stringify({products:db.backupData().products,customers:db.backupData().customers.map(({customer_attachments,...row})=>row),suppliers:db.backupData().suppliers,transactions:db.backupData().transactions,ledger:db.backupData().ledger});
 const app=require('../backend/server');const server=app.listen(0,'127.0.0.1');await new Promise(resolve=>server.once('listening',resolve));
 const origin='http://127.0.0.1:'+server.address().port;const browser=await chromium.launch();let page;const errors=[];let uploaded;
 try{
  const fixture=await browser.newPage({viewport:{width:3840,height:2160}});
  await fixture.setContent('<canvas width="3840" height="2160"></canvas>');
  const dataUrl=await fixture.locator('canvas').evaluate(canvas=>{const c=canvas.getContext('2d'),image=c.createImageData(3840,2160);let seed=74291;for(let i=0;i<image.data.length;i+=4){seed=(seed*48271)%2147483647;image.data[i]=seed&255;seed=(seed*48271)%2147483647;image.data[i+1]=seed&255;seed=(seed*48271)%2147483647;image.data[i+2]=seed&255;image.data[i+3]=255;}c.putImageData(image,0,0);for(const quality of [1,0.98,0.96,0.94,0.92,0.9]){const candidate=canvas.toDataURL('image/jpeg',quality),encoded=candidate.split(',')[1],padding=encoded.endsWith('==')?2:encoded.endsWith('=')?1:0,size=Math.floor(encoded.length*3/4)-padding;if(size>12*1024*1024&&size<=24*1024*1024)return candidate;}throw new Error('Unable to create a full-resolution JPEG in the 12-24 MB test range');});
  await fixture.close();const originalBytes=Buffer.from(dataUrl.split(',')[1],'base64');
  if(originalBytes.length<=12*1024*1024){const url=new URL('data:'+dataUrl.slice(5));throw new Error('4K test image did not exceed the old 12 MB limit: '+originalBytes.length);}
  if(originalBytes.length>24*1024*1024)throw new Error('4K camera image exceeded the supported 24 MB limit: '+originalBytes.length);
  await fs.promises.writeFile(path.join(dir,'camera-original-4k.jpg'),originalBytes);
  page=await browser.newPage({viewport:{width:390,height:844},acceptDownloads:true});page.setDefaultTimeout(30000);page.on('pageerror',e=>errors.push(e.message));
  await page.route('**/*',async route=>{const url=new URL(route.request().url());if(url.origin===origin||['blob:','data:'].includes(url.protocol))return route.continue();if(!url.pathname.startsWith('/api/'))return route.abort();const request=route.request();if(request.method()==='POST'&&url.pathname.endsWith('/customers/'+customer.id+'/attachments')){const body=request.postDataJSON();uploaded=Buffer.from(body.data.split(',')[1],'base64');}return route.fulfill({response:await route.fetch({url:origin+url.pathname+url.search})});});
  await page.goto(origin+'/#/pages/customers/index');await page.locator('.team-boot').waitFor({state:'hidden'});
  await expect.poll(()=>page.url()).toContain('customer-desk.html');
  await expect(page.locator('.eyebrow')).toContainText('客户中心');
  await page.screenshot({path:path.resolve('release/customer-photos-20261011/new-customer-center.png'),fullPage:true});
  await expect(page.getByRole('button',{name:'资料 / 账款'})).toBeVisible();
  await expect(page.getByRole('button',{name:'客户单据照片'})).toBeVisible();
  await page.getByRole('button',{name:'资料 / 账款'}).click();
  await expect.poll(()=>page.url()).toContain('view=records');
  await expect(page.getByText('单据照片',{exact:true})).toBeVisible();
  await page.goto(origin+'/#/pages/customers/index');await expect.poll(()=>page.url()).toContain('customer-desk.html');
  await page.getByRole('button',{name:'客户单据照片'}).click();
  await expect(page.locator('main h1')).toContainText('客户单据照片');
  await page.getByRole('button',{name:/4K原图测试客户/}).click();
  await expect(page.locator('main h1')).toContainText('4K原图测试客户');
  const chooser=page.waitForEvent('filechooser');await page.getByRole('button',{name:'拍照',exact:true}).click();await(await chooser).setFiles({name:'camera-original-4k.jpg',mimeType:'image/jpeg',buffer:originalBytes});
  await expect(page.getByText(/camera-original-4k.jpg/)).toBeVisible();
  await page.getByRole('button',{name:'上传照片到客户档案'}).click();await expect(page.getByRole('status')).toContainText('照片已保存到客户档案');
  const item=db.listCustomerAttachments(customer.id)[0];assert.equal(item.size,originalBytes.length);assert.equal(item.sha256,crypto.createHash('sha256').update(originalBytes).digest('hex'));assert.deepEqual(uploaded,originalBytes);
  const afterPhoto=JSON.stringify({products:db.backupData().products,customers:db.backupData().customers.map(({customer_attachments,...row})=>row),suppliers:db.backupData().suppliers,transactions:db.backupData().transactions,ledger:db.backupData().ledger.map(({attachments,...row})=>row)});
  if(afterPhoto!==originalFinancial)throw new Error('图片归档更改了业务库存、客户余额或账本');
  await page.getByRole('button',{name:/camera-original-4k.jpg/}).click();
  const image=page.getByRole('dialog',{name:'客户单据原图'}).locator('img');await expect(image).toBeVisible();await expect.poll(()=>image.evaluate(node=>node.naturalWidth),{timeout:30000}).toBe(3840);assert.equal(await image.evaluate(node=>node.naturalHeight),2160);
  assert.equal(JSON.stringify(db.backupData()).includes('customer_attachments'),true);assert.deepEqual(errors,[]);
  await page.screenshot({path:path.resolve('release/customer-photos-20261011/customer-original-4k.png'),fullPage:true});
  console.log(JSON.stringify({resolution:'3840x2160',originalBytes:originalBytes.length,storedBytes:item.size,sha256:item.sha256,roundTrip:'identical',previewDimensions:'3840x2160',inventoryChanged:false,errors}));
 }finally{await browser.close();server.closeAllConnections();await new Promise(resolve=>server.close(resolve));fs.rmSync(dir,{recursive:true,force:true});}
}
main().catch(error=>{console.error(error);process.exitCode=1;});
