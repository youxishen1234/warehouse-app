const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { chromium, expect } = require('@playwright/test');

async function main() {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'remote-print-browser-'));
  process.env.WAREHOUSE_DATA_FILE = path.join(directory, 'data.json');
  process.env.WAREHOUSE_DIMENSIONS_FILE = path.join(directory, 'dimensions.json');
  process.env.WAREHOUSE_REMOTE_PRINT_FILE = path.join(directory, 'queue.json');
  fs.writeFileSync(process.env.WAREHOUSE_DATA_FILE, JSON.stringify({ products: [], customers: [], suppliers: [], transactions: [], ledger: [] }));
  const db = require('../backend/db');
  const store = require('../backend/remote-print').createStore(process.env.WAREHOUSE_REMOTE_PRINT_FILE);
  const pair = store.register('测试打印电脑', '630K');
  const note = db.savePrintNote({ company: '远程打印测试', customer_id: null, customer_name: '隔离测试客户', address: '', phone: '', receiver: '', sender: '', date: '2026-10-13', paper: '241-93', items: [{ name: '', specification: '400×300×200', quantity: 1, price: 2, remark: '' }] });
  const built = !!process.env.REMOTE_PRINT_WEB_DIR;
  if (built) process.env.WAREHOUSE_WEB_ROOT = path.resolve(process.env.REMOTE_PRINT_WEB_DIR);
  const app = built ? require('../backend/server') : require('./helpers/print-center-source.cjs')(db);
  const server = app.listen(0, '127.0.0.1');
  await new Promise(resolve => server.once('listening', resolve));
  const origin = 'http://127.0.0.1:' + server.address().port;
  const artifacts = path.resolve(process.env.PRINT_ARTIFACTS || 'release/remote-print-recovery/check');
  fs.mkdirSync(artifacts, { recursive: true });
  const browser = await chromium.launch();
  let context, page;
  const held = [];
  try {
    context = await browser.newContext({ viewport: { width: 390, height: 844 }, locale: 'zh-CN' });
    await context.addInitScript(({ token, built }) => {
      localStorage.setItem('warehouse_remote_print_pair_v1', JSON.stringify(built ? { data: token } : token));
      Object.defineProperty(crypto, 'randomUUID', { value: undefined, configurable: true });
    }, { token: pair.client, built });
    let deviceOnline = false, deviceReady = false, dropSubmission = true, failStatus = false, stallStatus = false, submissions = 0;
    const sentIds = [], pageErrors = [];
    await context.route('**/*', async route => {
      const request = route.request(), url = new URL(request.url());
      if (!url.pathname.startsWith('/api/')) return url.origin === origin ? route.continue() : route.abort();
      if (url.pathname.startsWith('/api/remote-print/jobs/') && request.method() === 'GET') {
        if (stallStatus) { held.push(route); return; }
        if (failStatus) return route.abort();
      }
      const response = await route.fetch({ url: origin + url.pathname + url.search });
      if (url.pathname === '/api/remote-print/device') {
        const body = await response.json();
        body.data.online = deviceOnline; body.data.ready = deviceReady;
        return route.fulfill({ response, json: body });
      }
      if (url.pathname === '/api/remote-print/jobs' && request.method() === 'POST') {
        submissions++; sentIds.push(request.postDataJSON().id);
        if (dropSubmission) { dropSubmission = false; return route.abort(); }
      }
      return route.fulfill({ response });
    });
    page = await context.newPage(); page.setDefaultTimeout(15000);
    page.on('pageerror', error => pageErrors.push(error.message));
    const button = name => page.getByRole('button', { name, exact: true });
    const dialog = () => page.getByRole('dialog', { name: '送货单预览' });
    const jobs = () => JSON.parse(fs.readFileSync(process.env.WAREHOUSE_REMOTE_PRINT_FILE)).jobs;
    await page.goto(origin + '/#/pages/print-center/index?mode=edit');
    await page.locator('.team-boot').waitFor({ state: 'hidden' });
    await button('历史单据').click(); await button('重新打印').click();
    await page.getByText(/远程打印到店里/).click();
    await expect(page.getByText('打印电脑离线；可以先发送，电脑恢复在线后自动接收。')).toBeVisible();
    await button('发送到630K').click();
    await expect(dialog().getByRole('status')).toContainText('任务已提交，但打印电脑离线');
    assert.equal(submissions, 1); assert.equal(jobs().length, 1, 'lost response is recovered by status query');
    await expect(button('任务处理中…')).toBeDisabled();

    failStatus = true; await button('刷新打印状态').click();
    await expect(dialog().getByRole('alert')).toContainText('暂时无法查询打印状态');
    assert.equal(submissions, 1);
    failStatus = false; deviceOnline = true;
    await button('刷新打印状态').click();
    await expect(dialog().getByRole('status')).toContainText('打印机暂不可用');
    await expect(dialog().getByRole('alert')).toHaveCount(0);

    stallStatus = true; await button('刷新打印状态').click();
    await expect(dialog().getByRole('alert')).toContainText('查询超时', { timeout: 12000 });
    await page.screenshot({ path: path.join(artifacts, 'print-query-timeout.png'), fullPage: true });
    stallStatus = false;
    for (const route of held.splice(0)) await route.abort().catch(() => {});
    deviceReady = true;
    const claim = store.claim(pair.agent, true).job;
    assert.equal(claim.id, sentIds[0]);
    store.acknowledge(pair.agent, claim.id, { lease: claim.lease, status: 'uncertain', message: '测试结果未确认' });
    await button('刷新打印状态').click();
    await expect(dialog().getByRole('status')).toContainText('已暂停重复发送');
    store.acknowledge(pair.agent, claim.id, { lease: claim.lease, status: 'queued' });
    await expect(button('再打印一份')).toBeEnabled();
    await expect(dialog().getByRole('status')).toContainText('已送入630K打印队列');

    await button('返回单据').click(); await button('重新打印').click();
    await page.getByText(/远程打印到店里/).click();
    await expect(button('再打印一份')).toBeEnabled();
    assert.equal(submissions, 1, 'closing and reopening never resends automatically');
    await button('再打印一份').click(); await button('确认再打印一份').click();
    await expect.poll(() => jobs().length).toBe(2);
    assert.notEqual(sentIds[0], sentIds[1]);
    const copy = store.claim(pair.agent, true).job;
    store.acknowledge(pair.agent, copy.id, { lease: copy.lease, status: 'queued' });
    await expect(button('再打印一份')).toBeEnabled();
    await page.screenshot({ path: path.join(artifacts, 'remote-print-recovered.png'), fullPage: true });
    assert.equal(db.listPrintNotes()[0].version, note.version);
    assert.deepEqual(pageErrors, []);
    console.log(JSON.stringify({ built, offlineFeedback: true, lostResponseRecovered: true, timeoutVisible: true, printerOfflineFeedback: true, uncertainReceiptRecovered: true, reprintDeduplicated: true, physicalPrints: 0 }));
  } catch (error) {
    if (page) { console.error((await page.locator('body').innerText()).slice(-4500)); await page.screenshot({ path: path.join(artifacts, 'failure.png'), fullPage: true }); }
    throw error;
  } finally {
    for (const route of held) await route.abort().catch(() => {});
    if (context) await context.unrouteAll({ behavior: 'wait' });
    await browser.close(); server.closeAllConnections(); await new Promise(resolve => server.close(resolve));
    fs.rmSync(directory, { recursive: true, force: true });
  }
}
main().catch(error => { console.error(error); process.exitCode = 1; });
