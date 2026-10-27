const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { chromium, webkit, expect } = require('@playwright/test');
const QRCode = require('qrcode');

const wait = ms => new Promise(resolve => setTimeout(resolve, ms));
const dateValue = date => `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, '0')}-${String(date.getDate()).padStart(2, '0')}`;

async function main() {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'warehouse-print-native-flow-'));
  process.env.WAREHOUSE_DATA_FILE = path.join(directory, 'data.json');
  process.env.WAREHOUSE_DIMENSIONS_FILE = path.join(directory, 'dimensions.json');
  process.env.WAREHOUSE_REMOTE_PRINT_FILE = path.join(directory, 'remote-print.json');
  process.env.WAREHOUSE_WEB_ROOT = path.resolve(process.env.PRINT_WEB_DIR || 'release/print-center-01a1211e/web');
  fs.writeFileSync(process.env.WAREHOUSE_DATA_FILE, JSON.stringify({ products: [], customers: [], suppliers: [], transactions: [], ledger: [] }));

  const db = require('../backend/db');
  const remotePrint = require('../backend/remote-print');
  const remoteStore = remotePrint.createStore(process.env.WAREHOUSE_REMOTE_PRINT_FILE);
  // A registered, online shop computer is the other half of the pairing flow.
  const pairing = remoteStore.register('店里电脑', 'EPSON LQ-630K ESC/P2');
  remoteStore.claim(pairing.agent, true);

  const app = process.env.PRINT_SOURCE_PREVIEW === '1'
    ? require('./helpers/print-center-source.cjs')(db)
    : require('../backend/server');
  const customer = db.addCustomer({
    name: '华兴包装（原有单据）',
    contact: '王先生',
    phone: '13800000000',
    address: '河北省沧州市东光县工业园'
  });
  const product = db.addProduct({
    name: '五层瓦楞纸箱',
    specification: '400×300×200',
    unit: '个',
    stock: 1000,
    price: 3.5
  });
  const oldDate = new Date();
  oldDate.setDate(oldDate.getDate() - 7);
  const saved = db.savePrintNote({
    company: '东光县曙光纸箱包装',
    customer_id: customer.id,
    customer_name: customer.name,
    address: '河北省沧州市东光县工业园',
    phone: '13800000000',
    receiver: '王先生',
    sender: '张师傅',
    date: dateValue(oldDate),
    paper: '241-93',
    items: [{
      product_id: product.id,
      name: '五层瓦楞纸箱',
      specification: '400×300×200',
      unit: '个',
      quantity: 100,
      price: 3.5,
      remark: '原有单据备注'
    }]
  });
  assert.equal(saved.outbound_at, undefined, 'fixture is a persisted, not-yet-shipped note');

  const server = app.listen(0, '127.0.0.1');
  await new Promise(resolve => server.once('listening', resolve));
  const origin = 'http://127.0.0.1:' + server.address().port;
  const engine = process.env.PRINT_BROWSER || 'chromium';
  const browser = await (engine === 'webkit' ? webkit : chromium).launch();
  const artifacts = path.resolve(process.env.PRINT_ARTIFACTS || 'release/print-center-01a1211e/check', 'native-flow');
  fs.mkdirSync(artifacts, { recursive: true });

  const errors = [];
  const agentErrors = [];
  const agentJobs = [];
  const postedJobs = [];
  const submissionAttempts = [];
  const droppedSubmissionIds = new Set();
  let retryNoteId;
  let failNextDeviceQuery = false;
  let deviceQueryCount = 0;
  const physicalPrints = 0;
  let page;

  async function agentPost(route, body) {
    const response = await fetch(origin + '/api/remote-print/agent' + route, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'X-Print-Agent': pairing.agent },
      body: JSON.stringify(body)
    });
    const result = await response.json();
    assert.equal(response.ok, true, `shop computer API ${route}: ${JSON.stringify(result)}`);
    assert.equal(result.success, true, `shop computer API ${route}: ${JSON.stringify(result)}`);
    return result.data;
  }

  function scheduleShopComputer(jobRequest) {
    postedJobs.push(jobRequest);
    const task = (async () => {
      // Leave the initial waiting state observable before the shop computer
      // claims and acknowledges the task through its own API.
      await wait(1000);
      const claim = await agentPost('/poll', { ready: true });
      assert.ok(claim.job, 'online shop computer should claim the queued delivery note');
      assert.equal(claim.job.id, jobRequest.id);
      assert.equal(claim.job.note.id, jobRequest.note_id);
      agentJobs.push({ id: claim.job.id, noteId: claim.job.note.id, phase: 'claimed' });
      await wait(250);
      const acknowledgement = await agentPost('/jobs/' + encodeURIComponent(claim.job.id), {
        lease: claim.job.lease,
        status: 'queued'
      });
      assert.equal(acknowledgement.status, 'queued');
      // This fixture exercises only remote queue acceptance; no local spooler
      // or physical printer is connected by the test.
      agentJobs.push({ id: acknowledgement.id, noteId: acknowledgement.note_id, phase: 'acknowledged', status: acknowledgement.status });
    })();
    agentTasks.push(task);
    void task.catch(error => agentErrors.push(error.message));
  }
  const agentTasks = [];

  try {
    const context = await browser.newContext({ viewport: { width: 390, height: 844 }, deviceScaleFactor: 1, locale: 'zh-CN' });
    page = await context.newPage();
    page.setDefaultTimeout(15000);
    // Mimic the Android bridge exposed by an older native shell before Capacitor core initializes.
    // This intentionally has no native BluetoothLe plugin header/implementation.
    await page.addInitScript(() => { window.androidBridge = { postMessage() {} }; });
    page.on('pageerror', error => errors.push(error.message));

    await context.route('**/*', async route => {
      const request = route.request();
      const url = new URL(request.url());
      if (url.origin === origin || !/^https?:$/.test(url.protocol)) return route.continue();
      if (!url.pathname.startsWith('/api/')) return route.abort();
      const isSubmission = url.pathname === '/api/remote-print/jobs' && request.method() === 'POST';
      if (url.pathname === '/api/remote-print/device' && request.method() === 'GET') {
        deviceQueryCount++;
        if (failNextDeviceQuery) {
          failNextDeviceQuery = false;
          return route.fulfill({ status: 503, contentType: 'application/json', body: JSON.stringify({ success: false, message: '测试设备状态查询暂时失败' }) });
        }
      }
      const submitted = isSubmission ? request.postDataJSON() : undefined;
      if (submitted) {
        submissionAttempts.push(submitted);
        // Simulate a connection loss before the server receives the first
        // request. The status lookup should report 404 and allow a same-ID retry.
        if (submitted.note_id === retryNoteId && !droppedSubmissionIds.has(submitted.id)) {
          droppedSubmissionIds.add(submitted.id);
          return route.abort('failed');
        }
      }
      const response = await route.fetch({ url: origin + url.pathname + url.search });
      await route.fulfill({ response });
      if (submitted) scheduleShopComputer(submitted);
    });

    const button = name => page.getByRole('button', { name, exact: true });
    const footerButton = name => page.locator('main footer').getByRole('button', { name, exact: true });
    const preview = () => page.getByRole('dialog', { name: '送货单预览' });
    const remotePanel = () => page.locator('details').filter({ has: page.getByText(/远程打印到店里/) });
    const printNotice = () => page.locator('main [data-print-notice]');

    await page.goto(origin + '/#/pages/print-center/index');
    assert.deepEqual(await page.evaluate(() => ({
      native: window.Capacitor?.isNativePlatform?.() ?? false,
      platform: window.Capacitor?.getPlatform?.() ?? 'web',
      bluetoothLe: window.Capacitor?.isPluginAvailable?.('BluetoothLe') ?? false
    })), { native: true, platform: 'android', bluetoothLe: false }, 'the fixture represents a legacy native shell without the new BLE plugin');
    await expect(page.locator('main[data-print-view="home"]')).toBeVisible();
    await expect(page.getByRole('button', { name: new RegExp(saved.number) }).first()).toBeVisible();
    await page.getByRole('button', { name: new RegExp(saved.number) }).first().click();
    await expect(page.getByRole('heading', { name: '单据详情' })).toBeVisible();
    await expect(page.getByText(saved.customer_name, { exact: true })).toBeVisible();
    const autoPrint = page.getByLabel('出库后自动打印');
    await expect(autoPrint).not.toBeChecked();
    await expect(autoPrint).toBeDisabled();
    await page.screenshot({ path: path.join(artifacts, 'outbound-auto-print-default-off.png'), fullPage: true });

    await button('编辑单据').click();
    await expect(footerButton('已保存')).toBeDisabled();
    await expect(footerButton('预览打印')).toBeVisible();
    await footerButton('预览打印').click();
    await expect(preview()).toBeVisible();
    await page.screenshot({ path: path.join(artifacts, 'native-preview-unpaired.png'), fullPage: true });
    await expect(button('扫码连接打印电脑')).toBeVisible();
    await expect(page.getByLabel('打印电脑配对码')).toHaveCount(0);
    const fileChooserPromise = page.waitForEvent('filechooser');
    await button('扫码连接打印电脑').click();
    const fileChooser = await fileChooserPromise;
    await fileChooser.setFiles({
      name: 'print-pair.png',
      mimeType: 'image/png',
      buffer: await QRCode.toBuffer(pairing.client, { width: 360, margin: 2 })
    });
    await expect(remotePanel()).toHaveAttribute('open', '');
    await expect(preview().getByRole('button', { name: '发送到630K', exact: true })).toBeEnabled();
    await expect(remotePanel()).toContainText('店里电脑');
    await wait(1200);
    assert.equal(postedJobs.length, 0, 'ordinary preview stays manual after pairing and never auto-sends');
    await page.screenshot({ path: path.join(artifacts, 'native-preview-paired.png'), fullPage: true });
    await button('返回单据').click();

    await expect(footerButton('已保存')).toBeDisabled();
    await expect(footerButton('打印到630K')).toBeEnabled();
    await button('当前单据').click();
    await expect(page.getByRole('heading', { name: '单据详情' })).toBeVisible();
    await expect(autoPrint).not.toBeChecked();
    await expect(autoPrint).toBeEnabled();
    await button('编辑单据').click();
    await expect(footerButton('已保存')).toBeDisabled();
    await page.getByLabel('送货人', { exact: true }).fill('李师傅');
    await expect(footerButton('仅保存')).toBeEnabled();
    await expect(footerButton('保存并打印')).toBeEnabled();
    // Save-and-print is a single explicit action: saving opens preview and
    // automatically sends exactly once without requiring another tap.
    await footerButton('保存并打印').click();
    await expect.poll(() => db.listPrintNotes().find(note => note.id === saved.id)?.sender).toBe('李师傅');
    await expect(preview()).toBeVisible();
    const remoteDetails = remotePanel();
    await expect.poll(() => postedJobs.filter(job => job.note_id === saved.id).length).toBe(1);
    await expect(remoteDetails.getByRole('status')).toContainText('等待打印电脑接收');
    await expect.poll(() => agentJobs.filter(job => job.phase === 'acknowledged').length).toBe(1);
    await expect(preview()).toBeHidden({ timeout: 15000 });
    await expect(printNotice()).toBeVisible();
    await expect(printNotice()).toContainText('送入打印队列');
    assert.deepEqual(agentErrors, []);
    assert.equal(agentJobs[0].noteId, saved.id);
    assert.equal(agentJobs[1].status, 'queued');

    // Opening direct print again for an already queued, same-version note only
    // recovers the existing task. It must not silently create a second copy.
    await button('当前单据').click();
    await expect(page.getByRole('heading', { name: '单据详情' })).toBeVisible();
    await button('编辑单据').click();
    await expect(footerButton('打印到630K')).toBeEnabled();
    await footerButton('打印到630K').click();
    await expect(preview()).toBeVisible();
    await expect(preview().getByRole('button', { name: '再打印一份', exact: true })).toBeEnabled({ timeout: 12000 });
    await expect(page.getByRole('group', { name: '确认重新打印' })).toHaveCount(0);
    await wait(1200);
    assert.equal(postedJobs.filter(job => job.note_id === saved.id).length, 1, 'direct reopen of an already printed version must not submit a new copy');
    assert.equal(submissionAttempts.filter(job => job.note_id === saved.id).length, 1, 'existing same-version job is only recovered');
    await button('返回单据').click();

    await button('历史单据').click();
    await expect(page.locator('main[data-print-view="history"]')).toBeVisible();
    await expect(button('重新打印')).toBeVisible();
    await button('重新打印').click();
    await expect(preview()).toBeVisible();
    await expect(preview().getByRole('button', { name: '再打印一份', exact: true })).toBeEnabled({ timeout: 12000 });
    await expect(page.getByRole('group', { name: '确认重新打印' })).toHaveCount(0);
    await preview().getByRole('button', { name: '再打印一份', exact: true }).click();
    await expect.poll(() => postedJobs.length).toBe(2);
    await expect(preview()).toBeHidden({ timeout: 15000 });
    await expect.poll(() => agentJobs.filter(job => job.phase === 'acknowledged').length).toBe(2);
    assert.notEqual(postedJobs[1].id, postedJobs[0].id, 'history reprint intent creates a fresh remote task id');
    assert.equal(postedJobs[1].note_id, saved.id);
    assert.deepEqual(agentErrors, []);

    await button('历史单据').click();
    await expect(page.locator('main[data-print-view="history"]')).toBeVisible();
    await button('再来一单').click();
    await expect(page.locator('main[data-print-view="edit"]')).toBeVisible();
    await expect(page.locator('main [role="status"]').filter({ hasText: `已按 ${saved.number} 带入` })).toBeVisible();
    const copiedDate = await page.getByLabel('送货日期', { exact: true }).inputValue();
    const now = new Date();
    assert.equal(copiedDate, dateValue(now), 'copy-as-new uses today as the delivery date');
    assert.notEqual(copiedDate, saved.date, 'copy-as-new does not retain the original delivery date');
    await expect(page.getByLabel('收货单位', { exact: true })).toHaveValue(saved.customer_name);
    await expect(page.getByLabel('第1项产品名称')).toHaveValue(saved.items[0].name);
    await expect(page.getByLabel('第1项数量')).toHaveValue(String(saved.items[0].quantity));
    await expect(page.getByLabel('第1项备注')).toHaveValue(saved.items[0].remark);
    await footerButton('仅保存').click();
    await expect.poll(() => db.listPrintNotes().length).toBe(2);
    const copied = db.listPrintNotes().find(note => note.id !== saved.id);
    assert.ok(copied);
    retryNoteId = copied.id;
    assert.notEqual(copied.id, saved.id);
    assert.notEqual(copied.number, saved.number);
    assert.equal(copied.date, dateValue(now));
    assert.equal(copied.customer_name, saved.customer_name);
    assert.equal(copied.items[0].name, saved.items[0].name);
    assert.equal(copied.outbound_at ?? null, null, 'copy-as-new remains unshipped');
    await page.screenshot({ path: path.join(artifacts, 'copy-as-new-draft.png'), fullPage: true });

    // With the persisted default still off, shipping must open the preview but
    // must not silently create a remote task or print.
    await button('历史单据').click();
    await expect(page.locator('main[data-print-view="history"]')).toBeVisible();
    await page.getByRole('button', { name: new RegExp(saved.number) }).first().click();
    await expect(page.getByRole('heading', { name: '单据详情' })).toBeVisible();
    await expect(autoPrint).not.toBeChecked();
    await expect(button('确认出库')).toBeVisible();
    await expect(button('确认出库并打印')).toHaveCount(0);
    await button('确认出库').click();
    await expect(preview()).toBeVisible();
    await wait(1200);
    assert.equal(postedJobs.length, 2, 'default-off outbound flow must not auto-submit a third print job');
    await expect(preview().getByRole('button', { name: /发送到630K|再打印一份/, exact: true })).toBeEnabled();
    await button('返回单据').click();
    const shipped = db.listPrintNotes().find(note => note.id === saved.id);
    assert.ok(shipped.outbound_at, 'the test shipped the original linked note');
    assert.equal(db.getProduct(product.id).stock, 900);
    const shippedOriginalStock = db.getProduct(product.id).stock;
    assert.equal(copied.outbound_at ?? null, null, 'shipping the original does not ship its copy');

    // A dropped first request is recovered by querying the same durable task
    // ID, then retrying it once the server confirms it never received the job.
    await button('历史单据').click();
    await expect(page.locator('main[data-print-view="history"]')).toBeVisible();
    await page.screenshot({ path: path.join(artifacts, 'history-reprint-and-copy.png'), fullPage: true });
    await page.getByRole('button', { name: new RegExp(copied.number) }).first().click();
    await expect(page.getByRole('heading', { name: '单据详情' })).toBeVisible();
    await button('编辑单据').click();
    const deviceQueriesBeforeRetry = deviceQueryCount;
    failNextDeviceQuery = true;
    await footerButton('打印到630K').click();
    await expect(preview()).toBeVisible();
    await expect(preview().getByRole('button', { name: '重试连接', exact: true })).toBeEnabled();
    await expect.poll(() => deviceQueryCount).toBe(deviceQueriesBeforeRetry + 1);
    assert.equal(submissionAttempts.filter(job => job.note_id === copied.id).length, 0, 'a failed read-only connection check must not create a print job');
    const deviceQueriesAtRetryClick = deviceQueryCount;
    await preview().getByRole('button', { name: '重试连接', exact: true }).click();
    await expect.poll(() => deviceQueryCount, { timeout: 2000 }).toBeGreaterThan(deviceQueriesAtRetryClick);
    await expect(remotePanel()).toContainText('店里电脑');
    // Direct-print automatically makes the first attempt; this fixture drops
    // it before the server receives it, and the user retries once only after
    // status recovery confirms the original id was never accepted.
    await expect.poll(() => submissionAttempts.filter(job => job.note_id === copied.id).length).toBe(1);
    await expect(remotePanel().getByRole('alert').filter({ hasText: '服务器尚未收到该任务' })).toBeVisible();
    await expect(preview().getByRole('button', { name: '发送到630K', exact: true })).toBeEnabled();
    await wait(1000);
    assert.equal(submissionAttempts.filter(job => job.note_id === copied.id).length, 1, 'a failed direct attempt is not retried in a background loop');
    const retryAttempts = submissionAttempts.filter(job => job.note_id === copied.id);
    assert.equal(retryAttempts.length, 1, 'the first retry-fixture request was sent once before connection loss');
    await preview().getByRole('button', { name: '发送到630K', exact: true }).click();
    await expect.poll(() => postedJobs.filter(job => job.note_id === copied.id).length).toBe(1);
    await expect(preview()).toBeHidden({ timeout: 15000 });
    await expect.poll(() => agentJobs.filter(job => job.phase === 'acknowledged').length).toBe(3);
    const completedRetryAttempts = submissionAttempts.filter(job => job.note_id === copied.id);
    assert.equal(completedRetryAttempts.length, 2, 'retry sends one request after the initial connection loss');
    assert.equal(completedRetryAttempts[0].id, completedRetryAttempts[1].id, 'lost-response retry reuses the persisted task ID');
    assert.equal(remoteStore.status(pairing.client, completedRetryAttempts[0].id).status, 'queued');
    assert.deepEqual(agentErrors, []);

    // The opted-in setting should auto-submit exactly once after shipping and
    // close the preview only after the shop computer claims and queues the job.
    const autoPrintNote = db.savePrintNote({
      company: saved.company,
      customer_id: customer.id,
      customer_name: customer.name,
      address: saved.address,
      phone: saved.phone,
      receiver: saved.receiver,
      sender: saved.sender,
      date: dateValue(new Date()),
      paper: saved.paper,
      items: [{
        product_id: product.id,
        name: saved.items[0].name,
        specification: saved.items[0].specification,
        unit: saved.items[0].unit,
        quantity: 10,
        price: saved.items[0].price,
        remark: '启用自动打印测试'
      }]
    });
    await button('历史单据').click();
    await expect(page.locator('main[data-print-view="history"]')).toBeVisible();
    await page.getByRole('button', { name: new RegExp(autoPrintNote.number) }).first().click();
    await expect(page.getByRole('heading', { name: '单据详情' })).toBeVisible();
    await expect(autoPrint).not.toBeChecked();
    await autoPrint.check();
    await expect(autoPrint).toBeChecked();
    await expect(button('确认出库并打印')).toBeVisible();
    await expect(button('确认出库')).toHaveCount(0);
    await page.screenshot({ path: path.join(artifacts, 'outbound-auto-print-enabled.png'), fullPage: true });
    await button('确认出库并打印').click();
    await expect(preview()).toBeVisible();
    await expect.poll(() => postedJobs.filter(job => job.note_id === autoPrintNote.id).length).toBe(1);
    await page.screenshot({ path: path.join(artifacts, 'outbound-auto-print-preview.png'), fullPage: true });
    await expect.poll(() => agentJobs.filter(job => job.phase === 'acknowledged').length).toBe(4);
    await expect(preview()).toBeHidden({ timeout: 15000 });
    assert.equal(submissionAttempts.filter(job => job.note_id === autoPrintNote.id).length, 1, 'enabled outbound auto-print creates exactly one remote task');
    assert.ok(db.listPrintNotes().find(note => note.id === autoPrintNote.id).outbound_at);
    assert.equal(db.getProduct(product.id).stock, 890);
    assert.deepEqual(agentErrors, []);

    assert.deepEqual(errors, []);
    await Promise.all(agentTasks);
    assert.equal(physicalPrints, 0, 'the fixture queues remote jobs but does not invoke a physical printer');
    console.log(JSON.stringify({
      engine,
      nativeFooter: ['已保存 / 预览打印', '仅保存 / 保存并打印', '已保存 / 打印到630K'],
      pairedRemoteJobs: postedJobs.map(job => job.id),
      agentClaimAndAck: agentJobs,
      lostResponseRetry: { attempts: completedRetryAttempts.length, sameId: completedRetryAttempts[0].id === completedRetryAttempts[1].id },
      previewAutoExpandedAndClosed: true,
      notice: '送入打印队列',
      historyReprintWithoutConfirmation: true,
      copyAsNew: { originalId: saved.id, copyId: copied.id, originalDate: saved.date, copyDate: copied.date, outboundAt: copied.outbound_at ?? null },
      outboundAutoPrintDefault: false,
      outboundAutoPrintEnabled: true,
      physicalPrints,
      shippedOriginal: { id: shipped.id, outboundAt: shipped.outbound_at, remainingStock: shippedOriginalStock },
      pageErrors: errors,
      artifacts
    }));
  } catch (error) {
    if (page) {
      await page.screenshot({ path: path.join(artifacts, 'failure.png'), fullPage: true }).catch(() => {});
      console.error((await page.locator('body').innerText().catch(() => '')).slice(0, 2500));
    }
    throw error;
  } finally {
    await browser.close();
    server.closeAllConnections();
    await new Promise(resolve => server.close(resolve));
    await Promise.allSettled(agentTasks);
    fs.rmSync(directory, { recursive: true, force: true });
  }
}

main().catch(error => { console.error(error); process.exitCode = 1; });
