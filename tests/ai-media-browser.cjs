const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const express = require('express');
const { chromium, webkit } = require('playwright');
const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'warehouse-media-browser-'));
const wave = Buffer.alloc(44 + 32000);
wave.write('RIFF', 0); wave.writeUInt32LE(wave.length - 8, 4); wave.write('WAVEfmt ', 8);
wave.writeUInt32LE(16, 16); wave.writeUInt16LE(1, 20); wave.writeUInt16LE(1, 22);
wave.writeUInt32LE(16000, 24); wave.writeUInt32LE(32000, 28); wave.writeUInt16LE(2, 32); wave.writeUInt16LE(16, 34);
wave.write('data', 36); wave.writeUInt32LE(32000, 40);
const product = { id: 1, name: '语音测试纸箱', unit: '张', stock: 8, price: 2 };
const db = { revision: () => 1, listProducts: () => [product], listCustomers: () => [], listSuppliers: () => [] };
const app = express(), router = express.Router();
router.use(express.json({ limit: '17mb' }));
router.post('/auth/guest', (req, res) => res.json({ success: true, data: { token: 'media-test', user: { id: 1, username: 'test' } } }));
const received = [];
router.use((req, res, next) => { req.user = { id: 1, username: 'test' }; if (req.path.startsWith('/ai/')) received.push(req.path); next(); });
const env = { WAREHOUSE_AI_CONFIG_FILE: path.join(directory, 'settings.json'), WAREHOUSE_AI_BASE_URL: 'https://model.test/v1', WAREHOUSE_AI_MODEL: 'test-model', WAREHOUSE_AI_API_KEY: 'test-only', WAREHOUSE_AI_RATE_LIMIT: '1000' };
require('../backend/ai').install(router, db, {
  env, speechStatusImpl: () => ({ available: true, maxSeconds: 60, maxBytes: 6291456 }),
  transcribeImpl: async audio => { assert.ok(['wav', 'matroska', 'mov', 'ogg'].includes(audio.format)); return { text: '请帮我查询库存', seconds: 1 }; },
  fetchImpl: async (url, options) => {
    const input = JSON.parse(options.body).messages[1].content;
    const photo = Array.isArray(input);
    const call = photo ? { name: 'prepare_receipt_in', arguments: JSON.stringify({ lines: [{ product_name: product.name, quantity: 2, delivered_qty: 2, unit_price: 2 }] }) }
      : { name: 'prepare_query', arguments: '{"resource":"products"}' };
    return Response.json({ choices: [{ finish_reason: 'tool_calls', message: { tool_calls: [{ type: 'function', function: call }] } }] });
  }
});
router.get('/sync', (req, res) => res.json({ success: true, data: { revision: 1 } }));
router.get('/stats', (req, res) => res.json({ success: true, data: {} }));
router.use((req, res) => res.json({ success: true, data: [] }));
app.use('/api', router);
app.use(express.static(path.resolve(process.env.AI_WEB_DIR || 'release/ai-wechat/web-verified')));
app.use((error, req, res, next) => res.status(error.status || 500).json({ success: false, message: error.message }));

(async () => {
  const server = app.listen(0, '127.0.0.1'); await new Promise(resolve => server.once('listening', resolve));
  const origin = `http://127.0.0.1:${server.address().port}`;
  try {
    for (const [name, type] of [['webkit', webkit], ['chromium', chromium]]) {
      const browser = await type.launch(name === 'chromium' ? { args: ['--use-fake-device-for-media-stream', '--use-fake-ui-for-media-stream'] } : {});
      try {
        for (const width of [320, 390]) {
          const page = await browser.newPage({ viewport: { width, height: 844 }, isMobile: true, hasTouch: true });
          page.setDefaultTimeout(12000);
          const errors = []; page.on('pageerror', error => errors.push(error.message));
          await page.route(/\/api\//, async route => {
            const request = route.request();
            const response = await fetch(origin + new URL(request.url()).pathname, { method: request.method(), headers: { 'Content-Type': 'application/json', Authorization: 'Bearer media-test' }, body: request.postData() || undefined });
            await route.fulfill({ status: response.status, contentType: 'application/json', body: await response.text() });
          });
          await page.goto(origin);
          await page.getByText('AI 助手', { exact: true }).click();
          await page.locator('[data-ai-chat="20261004-wechat"]').waitFor();
          const root = page.locator('[data-ai-assistant]');
          const reset = async () => {
            await page.getByRole('button', { name: '聊天设置', exact: true }).click();
            await page.getByRole('button', { name: '新任务', exact: true }).click();
          };
          const right = async () => root.evaluate(element => Math.max(...[...element.querySelectorAll('*')].filter(node => node.getClientRects().length).map(node => node.getBoundingClientRect().right)));
          assert.ok(await right() <= width + 1);
          await page.getByRole('button', { name: '表情', exact: true }).click();
          await page.getByRole('button', { name: '插入表情 👍', exact: true }).click();
          assert.equal(await page.getByLabel('输入仓库指令').inputValue(), '👍');
          await page.getByLabel('输入仓库指令').fill('查询库存');
          await page.getByRole('button', { name: '发送', exact: true }).click();
          await page.getByText(product.name, { exact: true }).waitFor();
          const colors = await page.locator('[data-chat-message=user] span[class*=messageText]').evaluate(element => ({ color: getComputedStyle(element).backgroundColor, x: element.getBoundingClientRect().x }));
          assert.equal(colors.color, 'rgb(149, 236, 105)');
          await page.screenshot({ path: `release/ai-wechat/${name}-${width}-text.png` });
          await reset();
          await page.getByRole('button', { name: '更多发送方式', exact: true }).click();
          const file = page.waitForEvent('filechooser');
          await page.getByRole('button', { name: '上传语音', exact: true }).click();
          await (await file).setFiles({ name: 'query.wav', mimeType: 'audio/wav', buffer: wave });
          await page.getByLabel('待发送语音', { exact: true }).waitFor();
          await page.getByRole('button', { name: '发送语音', exact: true }).click();
          await page.getByRole('button', { name: '转文字', exact: true }).waitFor();
          await page.getByRole('button', { name: '转文字', exact: true }).click();
          await page.getByText('请帮我查询库存', { exact: true }).waitFor();
          await page.getByRole('button', { name: '播放语音 1 秒', exact: true }).click();
          await page.getByText(product.name, { exact: true }).waitFor();
          assert.equal(product.stock, 8);
          await reset();
          await page.getByRole('button', { name: '更多发送方式', exact: true }).click();
          await page.screenshot({ path: `release/ai-wechat/${name}-${width}-plus.png` });
          const photo = page.waitForEvent('filechooser');
          await page.getByRole('button', { name: '上传照片', exact: true }).click();
          await (await photo).setFiles(path.resolve('release/ai-reset/synthetic-receipt-vision.png'));
          await page.getByRole('button', { name: '发送照片', exact: true }).click();
          await page.getByRole('button', { name: '核对填写内容', exact: true }).waitFor();
          await page.getByAltText('发送照片 1', { exact: true }).waitFor();
          assert.equal(product.stock, 8);
          assert.ok(await right() <= width + 1);
          await page.setViewportSize({ width, height: 460 });
          const composer = await page.locator('[class*=__composer___]').boundingBox();
          assert.ok(composer.y + composer.height <= 461);
          await page.setViewportSize({ width, height: 844 });
          assert.deepEqual(errors, []);
          if (name === 'chromium' && width === 390) {
            await reset();
            await page.getByRole('button', { name: '发语音', exact: true }).click();
            const hold = page.getByRole('button', { name: '按住说话', exact: true });
            const voiceBox = await hold.boundingBox();
            const keyboardBox = await page.getByRole('button', { name: '键盘输入', exact: true }).boundingBox();
            assert.ok(Math.abs(voiceBox.y - keyboardBox.y) < 4, 'Hold button must replace the input on the same row');
            await page.evaluate(() => {
              const original = navigator.mediaDevices.getUserMedia.bind(navigator.mediaDevices);
              window.__testAudioStreams = [];
              window.__originalMicrophone = original;
              navigator.mediaDevices.getUserMedia = async constraints => { const stream = await original(constraints); window.__testAudioStreams.push(stream); return stream; };
            });
            const press = async () => { const box = await hold.boundingBox(); await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2); await page.mouse.down(); };
            const tracksEnded = () => page.evaluate(() => window.__testAudioStreams.every(stream => stream.getTracks().every(track => track.readyState === 'ended')));
            await press();
            await page.getByText('正在录音 · 1 秒', { exact: true }).waitFor();
            await page.screenshot({ path: 'release/ai-wechat/recording.png' });
            await page.mouse.up();
            await page.getByRole('button', { name: '转文字', exact: true }).waitFor();
            assert.ok(await tracksEnded());
            await reset();
            const voiceCallsBeforeCancel = received.filter(url => url === '/ai/voice').length;
            await press();
            await page.getByText('正在录音 · 1 秒', { exact: true }).waitFor();
            const box = await hold.boundingBox();
            await page.mouse.move(box.x + box.width / 2, box.y - 80);
            await page.getByText('松开手指，取消发送', { exact: true }).waitFor();
            await page.screenshot({ path: 'release/ai-wechat/cancel-recording.png' });
            await page.mouse.up();
            await page.getByText('松开手指，取消发送', { exact: true }).waitFor({ state: 'hidden' });
            assert.equal(received.filter(url => url === '/ai/voice').length, voiceCallsBeforeCancel);
            assert.ok(await tracksEnded());
            await press();
            await page.getByText('正在录音 · 1 秒', { exact: true }).waitFor();
            await hold.dispatchEvent('pointercancel');
            assert.ok(await tracksEnded());
            assert.equal(received.filter(url => url === '/ai/voice').length, voiceCallsBeforeCancel);
            await page.mouse.up();
            await page.evaluate(() => { navigator.mediaDevices.getUserMedia = async constraints => { await new Promise(resolve => setTimeout(resolve, 300)); const stream = await window.__originalMicrophone(constraints); window.__testAudioStreams.push(stream); return stream; }; });
            await press(); await page.mouse.up();
            await page.waitForFunction(() => window.__testAudioStreams.every(stream => stream.getTracks().every(track => track.readyState === 'ended')));
            assert.equal(received.filter(url => url === '/ai/voice').length, voiceCallsBeforeCancel);
            await page.evaluate(() => { navigator.mediaDevices.getUserMedia = () => Promise.reject(new DOMException('denied', 'NotAllowedError')); });
            await press(); await page.mouse.up();
            await page.getByText(/未获得麦克风权限/).waitFor();
            await page.evaluate(() => { window.Capacitor = { isNativePlatform: () => true, getPlatform: () => 'ios' }; window.__sgNativeDock = { microphone: false }; navigator.mediaDevices.getUserMedia = () => { throw new Error('Must not call microphone in legacy iOS shell'); }; });
            await press(); await page.mouse.up();
            await page.getByText(/当前安装包没有麦克风权限/).waitFor();
            assert.deepEqual(errors, []);
          }
          await page.close();
          console.log(`${name} ${width}: voice upload, photo endpoint, mobile layout and no warehouse writes PASS`);
        }
      } finally { await browser.close(); }
    }
    assert.ok(received.includes('/ai/voice') && received.includes('/ai/photo'));
    assert.ok(!received.includes('/ai/execute'));
  } finally { await new Promise(resolve => server.close(resolve)); fs.rmSync(directory, { recursive: true, force: true }); }
})().catch(error => { console.error(error); process.exitCode = 1; });
