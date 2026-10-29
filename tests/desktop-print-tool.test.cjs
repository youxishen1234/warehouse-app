const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const { pathToFileURL } = require('node:url');
const { JSDOM } = require('jsdom');

const root = path.resolve(__dirname, '..');
const tool = path.join(root, 'desktop', 'print-tool');
const printerName = 'EPSON LQ-630K ESC/P2';
const settle = () => new Promise(resolve => setImmediate(resolve));
const input = () => ({
  printerName,
  document: {
    key: 'isolated-print', number: 'TEST-PRINT-001', title: '送 货 单',
    company: '隔离测试', party: '打印夹具', date: '2026-10-29',
    operator: '', orderNumber: '',
    lines: [{ id: 1, product_id: 1, type: 'out', product_name: '纸箱', specification: '30 × 20 × 10', quantity: 1, unit: '个', unit_price: 2, amount: 2 }],
  },
});

async function mainFixture({ printers = [{ name: printerName, isDefault: true, status: 0 }], print } = {}) {
  const handlers = new Map(), windows = [], sent = [], dialogs = [];
  class Window {
    constructor(options) {
      this.options = options;
      this.webContents = {
        getPrintersAsync: async () => printers,
        setWindowOpenHandler: () => {},
        on: () => {},
        executeJavaScript: async () => ({ pages: 2 }),
        print: (options, done) => { sent.push(options); if (print) print(options, done); else done(true); },
      };
      windows.push(this);
    }
    async loadURL() {}
    loadFile(filename) { this.filename = filename; }
    destroy() { this.destroyed = true; }
  }
  const electron = {
    app: { requestSingleInstanceLock: () => true, whenReady: () => Promise.resolve(), on: () => {}, quit: () => {} },
    BrowserWindow: Window,
    ipcMain: { handle: (name, handler) => handlers.set(name, handler) },
    session: { fromPartition: () => ({ setPermissionRequestHandler: () => {}, webRequest: { onBeforeRequest: () => {} } }) },
    dialog: {
      showMessageBox: () => { dialogs.push('confirmation'); throw new Error('发送打印不应再次确认'); },
      showSaveDialog: async () => ({ canceled: true }),
    },
  };
  vm.runInNewContext(fs.readFileSync(path.join(tool, 'main.cjs'), 'utf8'), {
    require: name => name === 'electron' ? electron : name.startsWith('.') ? require(path.resolve(tool, name)) : require(name),
    __dirname: tool,
    console,
  }, { filename: path.join(tool, 'main.cjs') });
  await settle();
  const main = windows.find(window => window.options.show !== false);
  const event = { sender: main.webContents, senderFrame: { url: pathToFileURL(main.filename).href } };
  return { handlers, windows, sent, dialogs, event };
}

async function rendererFixture({ printers, preference = '', print = async () => ({ kind: 'queued', printerName, pages: 1 }) }) {
  const dom = new JSDOM(fs.readFileSync(path.join(tool, 'index.html'), 'utf8'), { runScripts: 'outside-only', url: 'https://print-tool.invalid/' });
  dom.window.ResizeObserver = class { observe() {} };
  dom.window.desktopPrint = { printers: async () => printers, print, pdf: async () => ({ kind: 'cancelled' }), preview: async () => '<html></html>' };
  if (preference) dom.window.localStorage.setItem('warehouse_desktop_printer_v1', preference);
  dom.window.eval(fs.readFileSync(path.join(tool, 'renderer.js'), 'utf8'));
  await settle();
  return dom;
}

test('one desktop send reaches the selected physical printer silently without another confirmation', async () => {
  const fixture = await mainFixture();
  const result = await fixture.handlers.get('print-tool:print')(fixture.event, input());
  assert.equal(result.kind, 'queued');
  assert.equal(result.printerName, printerName);
  assert.equal(result.pages, 2);
  assert.equal(fixture.sent.length, 1);
  assert.equal(fixture.sent[0].silent, true);
  assert.equal(fixture.sent[0].deviceName, printerName);
  assert.equal(fixture.sent[0].copies, 1);
  assert.deepEqual(fixture.dialogs, []);
  assert.ok(fixture.windows.filter(window => window.options.show === false).every(window => window.destroyed));
});

test('offline, missing and virtual printer targets never send paper or fall back to a different printer', async () => {
  for (const [printers, target, message] of [
    [[{ name: printerName, status: 0x80 }], printerName, /离线/],
    [[{ name: printerName, status: 0 }], 'Not Installed', /已安装/],
    [[{ name: 'Microsoft Print to PDF', status: 0 }], 'Microsoft Print to PDF', /实体打印机/],
  ]) {
    const fixture = await mainFixture({ printers });
    await assert.rejects(fixture.handlers.get('print-tool:print')(fixture.event, { ...input(), printerName: target }), message);
    assert.equal(fixture.sent.length, 0);
  }
});

test('an in-flight desktop print cannot be double submitted, and driver failure is surfaced', async () => {
  let complete;
  const fixture = await mainFixture({ print: (_options, done) => { complete = done; } });
  const first = fixture.handlers.get('print-tool:print')(fixture.event, input());
  await settle();
  await assert.rejects(fixture.handlers.get('print-tool:print')(fixture.event, input()), /已有任务/);
  assert.equal(fixture.sent.length, 1);
  complete(false, 'driver rejected');
  await assert.rejects(first, /driver rejected/);
});

test('the desktop renderer remembers the selected physical printer and excludes virtual targets', async () => {
  const other = 'Other USB Printer';
  const dom = await rendererFixture({
    printers: [{ name: printerName, isDefault: true }, { name: 'Microsoft Print to PDF', virtual: true }, { name: other }],
    preference: other,
  });
  try {
    const select = dom.window.document.getElementById('printer');
    assert.equal(select.value, other);
    assert.equal(select.options.length, 2);
    select.value = printerName;
    select.dispatchEvent(new dom.window.Event('change'));
    assert.equal(dom.window.localStorage.getItem('warehouse_desktop_printer_v1'), printerName);
    assert.equal(dom.window.document.getElementById('print').disabled, false);
    assert.equal(dom.window.document.getElementById('sample'), null);
  } finally { dom.window.close(); }
});

test('an unavailable remembered printer stays selected instead of silently switching the output device', async () => {
  const dom = await rendererFixture({ printers: [{ name: printerName, unavailable: true }, { name: 'Other USB Printer', isDefault: true }], preference: printerName });
  try {
    assert.equal(dom.window.document.getElementById('printer').value, printerName);
    assert.equal(dom.window.document.getElementById('print').disabled, true);
  } finally { dom.window.close(); }
});

test('a valid send skips preview and a second click while sending does not create another print', async () => {
  let finish, calls = 0;
  const dom = await rendererFixture({
    printers: [{ name: printerName, isDefault: true }],
    print: async payload => { calls++; assert.equal(payload.printerName, printerName); return new Promise(resolve => { finish = resolve; }); },
  });
  try {
    const document = dom.window.document;
    document.getElementById('party').value = '打印夹具';
    document.querySelector('[data-key="name"]').value = '纸箱';
    document.querySelector('[data-key="qty"]').value = '1';
    document.querySelector('[data-key="price"]').value = '2';
    document.getElementById('print').click();
    document.getElementById('print').click();
    assert.equal(calls, 1);
    finish({ kind: 'queued', printerName, pages: 1 });
    await settle();
    assert.equal(document.getElementById('print').disabled, false);
    assert.match(document.getElementById('status').textContent, /系统队列/);
  } finally { dom.window.close(); }
});
