const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawn } = require('node:child_process');
const { createHash, timingSafeEqual } = require('node:crypto');

function fail(message, code = 'INVALID_JOB', safeToRetry = true) {
  return Object.assign(new Error(message), { code, safeToRetry });
}

// Accept data only. The local renderer generates and escapes all HTML itself.
function validatePrintJob(input) {
  const object = value => value && typeof value === 'object' && !Array.isArray(value);
  const text = (value, limit, required = false) => {
    if (typeof value !== 'string' || value.length > limit || (required && !value.trim())) throw fail('打印资料不完整或过长，请重新加载单据');
    return value;
  };
  const number = (value, min, max, optional = false) => {
    if (optional && value == null) return undefined;
    if (typeof value !== 'number' || !Number.isFinite(value) || value < min || value > max) throw fail('打印数值超出范围，请检查单据和纸张设置');
    return value;
  };
  if (!object(input) || !object(input.document) || !object(input.settings)) throw fail('打印资料不完整');
  const { document: doc, settings: s } = input;
  const id = text(input.id, 100, true);
  if (!/^[a-zA-Z0-9-]{16,100}$/.test(id)) throw fail('打印任务编号无效');
  if (!Array.isArray(doc.lines) || doc.lines.length < 1 || doc.lines.length > 1000) throw fail('单据明细须为 1 至 1000 行');
  if (typeof s.showPrices !== 'boolean' || !['custom', '241-140', '241-93', '241-279', 'a4'].includes(s.paper)) throw fail('纸张设置无效');
  if (s.template !== undefined && !['blank', 'preprinted-outbound', 'outbound-four', 'delivery-note'].includes(s.template)) throw fail('套打模板设置无效');
  const document = {};
  for (const key of ['key', 'number', 'title', 'party', 'date', 'orderNumber', 'operator']) document[key] = text(doc[key], 500);
  for (const key of ['category', 'formNumber', 'supervisor', 'warehouse', 'accountant', 'address', 'phone', 'receiver']) if (doc[key] !== undefined) document[key] = text(doc[key], 500);
  document.sample = doc.sample === true;
  document.lines = doc.lines.map(line => {
    if (!object(line) || !['in', 'out'].includes(line.type) || line.voided_at) throw fail('单据包含不可打印的明细');
    return {
      id: number(line.id, 0, Number.MAX_SAFE_INTEGER),
      ...(line.printCode !== undefined ? { printCode: text(line.printCode, 100) } : {}),
      blank: line.blank === true,
      product_id: number(line.product_id, 0, Number.MAX_SAFE_INTEGER),
      type: line.type,
      quantity: number(line.quantity, 0, 1e12),
      unit_price: number(line.unit_price, 0, 1e12, true),
      amount: number(line.amount, 0, 1e12, true),
      product_name: text(line.product_name ?? '', 2000),
      specification: text(line.specification ?? '', 2000),
      unit: text(line.unit ?? '', 100),
      remark: text(line.remark ?? '', 10000),
    };
  });
  if (s.highClarity !== undefined && typeof s.highClarity !== 'boolean') throw fail('清晰打印设置无效');
  const settings = { template: s.template || 'blank', ...(s.formTitle !== undefined ? { formTitle: text(s.formTitle, 60) } : {}), paper: s.paper, company: text(s.company, 50), showPrices: s.showPrices, highClarity: s.highClarity !== false };
  for (const [key, min, max] of [['width', 180, 300], ['height', 80, 400], ['fontSize', 9, 12], ['rowsPerPage', 1, 20], ['offsetX', -5, 5], ['offsetY', -5, 5]]) settings[key] = number(s[key], min, max);
  return { id, printerName: text(input.printerName, 256, true), document, settings };
}

function printOptions(printerName, settings, supportedDpi) {
  if (!printerName || !printerName.trim()) throw fail('请选择打印机');
  return { silent: true, deviceName: printerName, printBackground: false, color: false,
    margins: { marginType: 'none' }, landscape: false, scaleFactor: 100, pagesPerSheet: 1,
    copies: 1, duplexMode: 'simplex', header: '', footer: '',
    pageSize: { width: Math.round(settings.width * 1000), height: Math.round(settings.height * 1000) },
    ...(settings.highClarity && supportedDpi ? { dpi: { horizontal: supportedDpi.horizontal, vertical: supportedDpi.vertical } } : {}) };
}

function runNative(request) {
  return new Promise((resolve, reject) => {
    const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'warehouse-print-'));
    const inputFile = path.join(directory, 'request.json');
    fs.writeFileSync(inputFile, JSON.stringify(request), { mode: 0o600 });
    const env = { ...process.env };
    delete env.ELECTRON_RUN_AS_NODE;
    const child = spawn(require('electron'), [path.join(__dirname, 'dot-matrix-electron.cjs'), inputFile], {
      env, windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'],
    });
    let output = '', finished = false;
    const finish = (error, result) => {
      if (finished) return;
      finished = true;
      clearTimeout(timer);
      // Only the freshly-created, private task directory is removed.
      fs.rm(directory, { recursive: true, force: true, maxRetries: 3 }, () => {});
      if (error) reject(error); else resolve(result);
    };
    const timer = setTimeout(() => {
      child.kill();
      finish(fail(request.action === 'print' ? '打印响应超时，请先检查打印队列和实际出纸，不要重复发送。' : '读取打印机超时，请重试。', 'NATIVE_TIMEOUT', request.action !== 'print'));
    }, request.action === 'print' ? 90000 : 25000);
    child.stdout.setEncoding('utf8');
    child.stdout.on('data', chunk => {
      output += chunk;
      if (output.length > 16 * 1024 * 1024) { child.kill(); finish(fail('打印响应过大', 'NATIVE_RESPONSE', false)); }
    });
    child.stderr.resume();
    child.once('error', () => finish(fail('本机打印服务无法启动，请重新启动预览服务', 'NATIVE_START')));
    child.once('close', () => {
      if (finished) return;
      try {
        const line = output.split(/\r?\n/).find(value => value.startsWith('WAREHOUSE_PRINT_RESULT:'));
        if (!line) throw fail('本机打印服务中断，请检查打印队列后再操作', 'NATIVE_EXIT', request.action !== 'print');
        const result = JSON.parse(line.slice('WAREHOUSE_PRINT_RESULT:'.length));
        if (!result.ok) throw fail(result.message, result.code, result.safeToRetry);
        finish(null, result.data);
      } catch (error) { finish(error); }
    });
  });
}

function createPrintService(runner = runNative) {
  const jobs = new Map();
  let active = false;
  return {
    list: () => runner({ action: 'list' }),
    async submit(input) {
      const job = validatePrintJob(input);
      const signature = createHash('sha256').update(JSON.stringify(job)).digest('hex');
      const previous = jobs.get(job.id);
      if (previous) {
        if (previous.signature !== signature) throw fail('打印任务编号已使用，请刷新页面', 'JOB_CONFLICT');
        return previous.promise;
      }
      if (active) throw fail('已有单据正在发送，请稍后再试', 'PRINT_BUSY');
      if (jobs.size >= 500) throw fail('本次打印服务已达到任务上限，请重新启动服务', 'JOB_LIMIT');
      active = true;
      const promise = Promise.resolve().then(() => runner({ action: 'print', job })).finally(() => { active = false; });
      jobs.set(job.id, { signature, promise });
      return promise;
    },
  };
}

function authorizeLocalPrint(request, { port, token }, requireToken = true) {
  if (request.headers.host !== `127.0.0.1:${port}`) return false;
  const origin = request.headers.origin;
  if (origin && origin !== `http://127.0.0.1:${port}`) return false;
  if (['cross-site', 'same-site'].includes(request.headers['sec-fetch-site'])) return false;
  if (!requireToken) return true;
  const supplied = request.headers['x-warehouse-print-token'];
  return typeof supplied === 'string' && Buffer.byteLength(supplied) === Buffer.byteLength(token) && timingSafeEqual(Buffer.from(supplied), Buffer.from(token));
}

module.exports = { validatePrintJob, printOptions, runNative, createPrintService, authorizeLocalPrint, fail };
