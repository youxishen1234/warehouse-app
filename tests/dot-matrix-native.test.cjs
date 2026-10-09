const assert = require('node:assert/strict');
const test = require('node:test');
const { validatePrintJob, printOptions, createPrintService, authorizeLocalPrint, fail } = require('../scripts/dot-matrix-native.cjs');

const makeJob = () => ({
  id: 'print-request-00000001', printerName: 'EPSON LQ-630KII ESC/P2',
  document: { key: 'sample', number: 'TEST-001', title: '出库单', party: '客户', date: '', orderNumber: '', operator: '', sample: true,
    lines: [{ id: 1, product_id: 1, type: 'out', product_name: '纸箱', quantity: 100, unit: '个', amount: 350, unit_price: 3.5 }] },
    settings: { paper: 'custom', company: '曙光纸箱包装', width: 241.3, height: 139.7, fontSize: 11, rowsPerPage: 5, offsetX: 0, offsetY: 0, showPrices: true, highClarity: true },
});

test('local channel rejects cross-origin, rebound-host and missing/incorrect capabilities', () => {
  const config = { port: 4316, token: 'x'.repeat(64) };
  const good = { host: '127.0.0.1:4316', origin: 'http://127.0.0.1:4316', 'x-warehouse-print-token': config.token, 'sec-fetch-site': 'same-origin' };
  assert.equal(authorizeLocalPrint({ headers: good }, config), true);
  for (const patch of [
    { host: 'attacker.example:4316' }, { origin: 'https://attacker.example' }, { origin: 'http://127.0.0.1:4000' },
    { 'x-warehouse-print-token': '' }, { 'x-warehouse-print-token': 'y'.repeat(64) }, { 'x-warehouse-print-token': '中'.repeat(64) },
    { 'sec-fetch-site': 'cross-site' }, { 'sec-fetch-site': 'same-site' },
  ]) assert.equal(authorizeLocalPrint({ headers: { ...good, ...patch } }, config), false);
});

test('jobs are bounded structured data; external markup, URLs and native options cannot enter the renderer', () => {
  const job = makeJob();
  job.html = '<script>require("fs")</script>';
  job.url = 'https://attacker.example';
  job.settings.silent = false;
  const accepted = validatePrintJob(job);
  assert.equal(accepted.html, undefined);
  assert.equal(accepted.url, undefined);
  assert.equal(accepted.settings.silent, undefined);
  for (const mutate of [
    x => { x.printerName = ''; }, x => { x.id = '../../file'; }, x => { x.document.lines = []; },
    x => { x.document.lines = Array(1001).fill(x.document.lines[0]); }, x => { x.document.lines[0].voided_at = 1; },
    x => { x.settings.width = 100000; }, x => { x.settings.height = NaN; }, x => { x.document.lines[0].quantity = Infinity; },
    x => { x.document.lines[0].remark = '长'.repeat(10001); },
  ]) { const candidate = makeJob(); mutate(candidate); assert.throws(() => validatePrintJob(candidate)); }
});

test('explicit printer and physical settings never depend on system default or host print dropdown', () => {
  const { settings } = makeJob();
  const options = printOptions('EPSON LQ-630KII ESC/P2', settings);
  assert.equal(options.deviceName, 'EPSON LQ-630KII ESC/P2');
  assert.deepEqual(options.pageSize, { width: 241300, height: 139700 });
  assert.equal(options.silent, true);
  assert.equal(options.scaleFactor, 100);
  assert.equal(options.copies, 1);
  assert.equal(options.header + options.footer, '');
  assert.deepEqual(printOptions('EPSON LQ-630KII ESC/P2', settings, { horizontal: 360, vertical: 180 }).dpi, { horizontal: 360, vertical: 180 });
  assert.equal(printOptions('EPSON LQ-630KII ESC/P2', { ...settings, highClarity: false }, { horizontal: 360, vertical: 180 }).dpi, undefined);
  assert.equal(options.dpi, undefined, 'other printers do not receive a guessed resolution');
  assert.throws(() => printOptions('', settings), /选择打印机/);
});

test('native rendering retains four-row draft fields and validates template and title', () => {
  const job = makeJob();
  job.settings.template = 'outbound-four'; job.settings.formTitle = '东光县曙光纸箱包装出库单';
  Object.assign(job.document, { supervisor: '王主管', warehouse: '仓管', accountant: '会计', formNumber: 'MANUAL-01', category: '纸箱' });
  Object.assign(job.document.lines[0], { printCode: 'ABC-01', blank: false });
  const result = validatePrintJob(job);
  assert.equal(result.settings.formTitle, job.settings.formTitle);
  assert.equal(result.settings.template, 'outbound-four');
  assert.equal(result.document.warehouse, '仓管');
  assert.equal(result.document.lines[0].printCode, 'ABC-01');
  assert.throws(() => validatePrintJob({ ...job, settings: { ...job.settings, template: 'arbitrary-html' } }), /模板/);
  assert.throws(() => validatePrintJob({ ...job, settings: { ...job.settings, formTitle: 'x'.repeat(61) } }));
});

test('repeated clicks, concurrent requests and network retries only submit a job once', async () => {
  let resolve, calls = 0;
  const service = createPrintService(async request => {
    calls++;
    assert.equal(request.job.printerName, 'EPSON LQ-630KII ESC/P2');
    return new Promise(done => { resolve = done; });
  });
  const job = makeJob();
  const first = service.submit(job);
  const second = service.submit(job);
  await assert.rejects(service.submit({ ...job, id: 'another-request-00002' }), /正在发送/);
  await assert.rejects(service.submit({ ...job, printerName: 'Deli A4 Printer' }), /编号已使用/);
  resolve({ kind: 'queued', printerName: job.printerName });
  assert.deepEqual(await first, await second);
  assert.deepEqual(await service.submit(job), await first);
  assert.equal(calls, 1);
});

test('an uncertain native failure is remembered and cannot silently resend or fall back to Deli', async () => {
  let calls = 0;
  const service = createPrintService(async () => { calls++; throw fail('请核对打印队列', 'NATIVE_TIMEOUT', false); });
  for (let i = 0; i < 2; i++) await assert.rejects(service.submit(makeJob()), error => error.safeToRetry === false);
  assert.equal(calls, 1);
});
