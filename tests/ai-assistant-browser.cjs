const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const express = require('express');
const { chromium, webkit } = require('playwright');
const workspace = fs.mkdtempSync(path.join(os.tmpdir(), 'ai-browser-'));
process.env.WAREHOUSE_DATA_FILE = path.join(workspace, 'data.json');
fs.writeFileSync(process.env.WAREHOUSE_DATA_FILE, JSON.stringify({products: [], suppliers: [], customers: [], ledger: [], transactions: []}));
const db = require('../backend/db');
const { createSettings } = require('../backend/ai-settings');
const env = { WAREHOUSE_AI_CONFIG_FILE: path.join(workspace, 'model.json'), WAREHOUSE_AI_RATE_LIMIT: '1000' };
const product = db.addProduct({name: '浏览器测试纸箱', stock: 10, unit: '张', price: 2});
const app = express();
const api = express.Router();
api.use(express.json({limit: '9mb'}));
api.post('/auth/guest', (req, res) => res.json({success: true, data: {token: 'operator', user: {id: 'operator', role: 'operator', username: 'test'}}}));
api.post('/auth/login', (req, res) => res.json({success: true, data: {token: 'test-admin', user: {id: 'admin', role: 'admin'}}}));
api.use((req, res, next) => { req.user = {id: req.get('Authorization'), username: 'test', role: req.get('Authorization') === 'Bearer test-admin' ? 'admin' : 'operator'}; next(); });
const modelImages = [];
require('../backend/ai').install(api, db, { env, fetchImpl: async (url, opts) => {
  assert.equal(url, 'https://model.example.test/v1/chat/completions');
  assert.equal(opts.headers.Authorization, 'Bearer private-browser-key');
  const body = JSON.parse(opts.body);
  const photo = Array.isArray(body.messages[1].content);
  if (photo) modelImages.push(body.messages[1].content);
  const call = photo ? {name: 'prepare_receipt_in', arguments: JSON.stringify({lines: [{product_name: product.name, quantity: 2, delivered_qty: 2, unit_price: 2}]})}
    : {name: 'prepare_query', arguments: JSON.stringify({resource: 'products'})};
  return Response.json({choices: [{finish_reason: 'tool_calls', message: {tool_calls: [{type: 'function', function: call}]}}]});
} });
api.get('/sync', (req, res) => res.json({success: true, data: {revision: db.revision()}}));
api.get('/stats', (req, res) => res.json({success: true, data: db.stats()}));
api.use((req, res) => res.json({success: true, data: []}));
app.use('/api', api);
app.use(express.static(path.resolve(process.env.AI_WEB_DIR || 'release/ai-reset/web')));
app.use((error, req, res, next) => res.status(error.status || 500).json({success: false, message: error.message}));
const byClass = (page, name) => page.locator(`[data-ai-assistant] [class*="__${name}___"]`);

(async () => {
  const server = app.listen(0, '127.0.0.1');
  await new Promise(r => server.once('listening', r));
  const origin = `http://127.0.0.1:${server.address().port}`;
  try {
    for (const [name, type] of [['webkit', webkit], ['chromium', chromium]]) {
      const browser = await type.launch();
      try {
        for (const width of [320, 390, 430]) {
          const page = await browser.newPage({viewport: {width, height: width === 320 ? 700 : 844}, isMobile: true, hasTouch: true});
          page.setDefaultTimeout(8000);
          const errors = [];
          page.on('pageerror', e => errors.push(e.message));
          await page.route(/\/api\//, async route => {
            const req = route.request();
            const response = await fetch(origin + new URL(req.url()).pathname, {method: req.method(), headers: {'Content-Type': 'application/json', Authorization: req.headers().authorization || '', 'Idempotency-Key': req.headers()['idempotency-key'] || '', 'If-Match': req.headers()['if-match'] || ''}, body: req.postData() || undefined});
            await route.fulfill({status: response.status, contentType: 'application/json', headers: {'X-Warehouse-Revision': String(db.revision())}, body: await response.text()});
          });
          await page.goto(origin);
          await page.getByText('AI 助手', {exact: true}).click();
          await page.waitForURL(/ai-assistant/);
          await page.getByText('基础指令模式', {exact:true}).waitFor();
          const layout = await page.evaluate(() => {
            const root = document.querySelector('[data-ai-assistant]');
            const get = name => root.querySelector(`[class*="__${name}___"]`);
            const box = e => {const b = e.getBoundingClientRect(); return {x:b.x,y:b.y,width:b.width,height:b.height,bottom:b.bottom,right:b.right};};
            return {subtitle: box(get('subtitle')), header:box(get('header')), input:box(get('messageInput')), send:box(get('send')), composer:box(get('composer')), maxWidth:Math.max(...[...root.querySelectorAll('*')].map(e=>e.getBoundingClientRect().right)), buttons:[...get('shortcuts').querySelectorAll('button')].map(e=>({disabled:e.disabled,color:getComputedStyle(e).color,opacity:getComputedStyle(e).opacity,...box(e)}))};
          });
          assert.ok(layout.subtitle.width > 150 && layout.subtitle.height < 40, JSON.stringify(layout));
          assert.ok(layout.header.height < 95 && layout.input.width > 190 && layout.send.width < 100);
          assert.ok(layout.maxWidth <= width + 1 && layout.composer.bottom <= (width === 320 ? 700 : 844) + 1);
          for (const button of layout.buttons) assert.ok(!button.disabled && button.opacity === '1' && button.width > 120 && button.height >= 40 && button.color !== 'rgba(255, 255, 255, 0.6)');
          await page.screenshot({path:`release/ai-reset/${name}-${width}.png`});
          await page.getByRole('button', {name:'查询库存',exact:true}).click();
          await page.getByText(product.name,{exact:true}).waitFor();
          assert.equal(db.getProduct(product.id).stock, 10);
          await page.getByRole('button', {name:'新任务',exact:true}).click();
          await page.getByRole('button', {name:'请帮我入库',exact:true}).click();
          await page.getByLabel('商品编号',{exact:true}).fill(String(product.id));
          await page.getByLabel('数量',{exact:true}).fill('3');
          await page.getByRole('button', {name:'核对填写内容',exact:true}).click();
          await page.getByRole('button', {name:'确认提交',exact:true}).waitFor();
          assert.equal(db.getProduct(product.id).stock, 10, 'preview must not change stock');
          // The full write path is covered once; remaining sizes exercise form layout.
          if (name === 'webkit' && width === 390) {
            await page.getByRole('button', {name:'确认提交',exact:true}).click();
            await page.getByRole('button', {name:'打印本单',exact:true}).waitFor();
            assert.equal(db.getProduct(product.id).stock, 13);
            await page.getByRole('button', {name:'打印本单',exact:true}).click();
            await page.locator('iframe[title="单据打印预览"]').waitFor();
            const doc = await page.locator('iframe').getAttribute('srcdoc');
            assert.ok(doc.includes(product.name));
            // Restore only this isolated test database for the remaining cases.
            db.stockOut(product.id, 3, 'test', '', null, {unit_price:2});
          }
          await page.getByRole('button', {name:'新任务',exact:true}).click();
          await page.getByRole('button', {name:'拍入库单',exact:true}).click();
          await page.getByRole('region', {name:'模型接入设置'}).waitFor();
          assert.ok(await page.getByText('拍单识别需要先接入', {exact:false}).count());
          assert.equal(modelImages.length, 0, 'unconfigured photos never call the provider');
          await page.getByRole('button', {name:'收起',exact:true}).click();
          // Keyboard-sized viewport: the composer remains reachable and horizontal.
          await page.setViewportSize({width,height:460});
          const keyboard = await byClass(page,'composer').boundingBox();
          assert.ok(keyboard.y >= 0 && keyboard.y + keyboard.height <= 461);
          assert.deepEqual(errors, []);
          console.log(`${name} ${width}: home entry, mobile layout, query, inbound draft, keyboard PASS`);
          if (name === 'chromium' && width === 430) {
            await page.setViewportSize({width,height:844});
            await page.getByRole('button', {name:'接入设置',exact:true}).click();
            await page.getByLabel('管理员密码',{exact:true}).fill('test-admin-password');
            await page.getByRole('button', {name:'验证管理员',exact:true}).click();
            await page.getByLabel('服务地址（Base URL）',{exact:true}).fill('https://model.example.test/v1');
            await page.getByLabel('模型名称',{exact:true}).fill('test-vision-model');
            await page.getByLabel('API Key',{exact:true}).fill('private-browser-key');
            await page.getByRole('button', {name:'检测并保存',exact:true}).click();
            await page.getByText(/已保存并生效/).waitFor();
            assert.equal(createSettings(env).current().WAREHOUSE_AI_MODEL, 'test-vision-model');
            assert.equal(await page.getByLabel('API Key',{exact:true}).inputValue(), '');
            await page.getByRole('button', {name:'收起',exact:true}).click();
            await page.getByRole('button', {name:'新任务',exact:true}).click();
            const chooser = page.waitForEvent('filechooser');
            await page.getByRole('button', {name:'上传照片',exact:true}).click();
            await (await chooser).setFiles({name:'receipt.png',mimeType:'image/png',buffer:fs.readFileSync('release/ai-reset/webkit-390.png')});
            await page.getByAltText('单据照片 1',{exact:true}).waitFor();
            await page.getByRole('button', {name:'发送照片',exact:true}).click();
            await page.getByLabel('商品 1 商品编号', {exact:true}).waitFor({timeout:1000}).catch(()=>{});
            await page.waitForFunction(() => [...document.querySelectorAll('input')].some(e=>e.value==='2'));
            assert.equal(modelImages.length,1);
            assert.equal(db.getProduct(product.id).stock,10,'photo recognition only creates a draft');
            assert.equal(await page.evaluate(() => JSON.stringify(localStorage).includes('private-browser-key')), false);
            console.log('administrator settings, saved model, photo draft (simulated provider): PASS');
          }
          await page.close();
        }
      } finally { await browser.close(); }
    }
  } finally { await new Promise(r=>server.close(r)); fs.rmSync(workspace,{recursive:true,force:true}); }
})().catch(e=>{console.error(e);process.exitCode=1;});
