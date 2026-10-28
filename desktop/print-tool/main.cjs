const { app, BrowserWindow, ipcMain, dialog, session } = require('electron');
const fs = require('node:fs');
const path = require('node:path');
const ts = require('typescript');
const vm = require('node:vm');
const { pathToFileURL } = require('node:url');
const { randomUUID } = require('node:crypto');
const { validatePrintJob, printOptions } = require('../../scripts/dot-matrix-native.cjs');
const templatePath = path.resolve(__dirname, '../../src/utils/dot-matrix-print.ts');
const source = ts.transpileModule(fs.readFileSync(templatePath, 'utf8'), {
  compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2020 },
}).outputText;
const template = { exports: {} };
vm.runInNewContext(source, template, { filename: templatePath });
let win;
let active = false;
const indexUrl = pathToFileURL(path.join(__dirname, 'index.html')).href;

function validate(input) {
  const settings = template.exports.normalizePrintSettings({
    ...template.exports.DEFAULT_PRINT_SETTINGS, template: 'delivery-note',
    paper: '241-93', company: input?.document?.company || '东光县曙光纸箱包装',
    showPrices: input?.showPrices !== false,
  });
  return validatePrintJob({ id: randomUUID(), printerName: input?.printerName || 'preview', document: input?.document, settings });
}
function assertSender(event) {
  if (!win || event.sender !== win.webContents || event.senderFrame?.url !== indexUrl) throw new Error('打印请求来源无效');
}
async function renderJob(job, callback) {
  const isolated = session.fromPartition('desktop-print-' + randomUUID());
  isolated.setPermissionRequestHandler((_, __, cb) => cb(false));
  isolated.webRequest.onBeforeRequest((details, cb) => cb({ cancel: !details.url.startsWith('data:text/html') }));
  const renderer = new BrowserWindow({ show: false, webPreferences: { session: isolated, sandbox: true, contextIsolation: true, nodeIntegration: false } });
  renderer.webContents.setWindowOpenHandler(() => ({ action: 'deny' }));
  renderer.webContents.on('will-navigate', e => e.preventDefault());
  try {
    const html = template.exports.buildDotMatrixHtml(job.document, job.settings);
    await renderer.loadURL('data:text/html;charset=utf-8,' + encodeURIComponent(html));
    const layout = await renderer.webContents.executeJavaScript(`(async()=>{const exports={};${source}\nawait document.fonts.ready;return exports.paginateDotMatrixDocument(document,${JSON.stringify(job.document)},${JSON.stringify(job.settings)});})()`);
    return await callback(renderer.webContents, layout);
  } finally { renderer.destroy(); }
}
ipcMain.handle('print-tool:printers', async event => {
  assertSender(event);
  return (await win.webContents.getPrintersAsync()).map(p => ({ name: p.name, isDefault: p.isDefault, status: p.status }));
});
ipcMain.handle('print-tool:preview', async (event, input) => {
  assertSender(event);
  const job = validate(input);
  return renderJob(job, async contents => contents.executeJavaScript('document.documentElement.outerHTML'));
});
ipcMain.handle('print-tool:pdf', async (event, input) => {
  assertSender(event);
  const job = validate(input);
  const result = await dialog.showSaveDialog(win, { title: '保存送货单 PDF', defaultPath: '送货单-' + new Date().toISOString().slice(0, 10) + '.pdf', filters: [{ name: 'PDF', extensions: ['pdf'] }] });
  if (result.canceled || !result.filePath) return { kind: 'cancelled' };
  return renderJob(job, async (contents, layout) => {
    const pdf = await contents.printToPDF({ preferCSSPageSize: true, printBackground: false, displayHeaderFooter: false });
    await fs.promises.writeFile(result.filePath, pdf);
    return { kind: 'pdf', pages: layout.pages, filePath: result.filePath };
  });
});
ipcMain.handle('print-tool:print', async (event, input) => {
  assertSender(event);
  if (active) throw new Error('已有任务正在办理，请稍候');
  active = true;
  try {
    const job = validate(input);
    const printers = await win.webContents.getPrintersAsync();
    const printer = printers.find(p => p.name === job.printerName);
    if (!printer) throw new Error('请选择本机已安装的打印机');
    if (printer.status & (0x80 | 0x1000 | 0x2)) throw new Error('打印机离线或存在错误，请检查连接和纸张');
    if (/print to pdf/i.test(printer.name)) throw new Error('保存 PDF 请使用“导出 PDF”按钮');
    return await renderJob(job, async (contents, layout) => {
      const confirmation = await dialog.showMessageBox(win, { type: 'question', title: '确认发送打印', message: '打印到：' + printer.name,
        detail: `客户：${job.document.party}\n共 ${layout.pages} 页，每页一份，241 × 93 mm。\n请确认纸张已装好；该操作只打印，不改变库存或账款。`, buttons: ['取消', '打印一份'], defaultId: 0, cancelId: 0 });
      if (confirmation.response !== 1) return { kind: 'cancelled' };
      await new Promise((resolve, reject) => contents.print(printOptions(printer.name, job.settings), (ok, reason) => ok ? resolve() : reject(new Error('打印未被接受：' + (reason || '请检查打印队列')))));
      return { kind: 'queued', printerName: printer.name, pages: layout.pages };
    });
  } finally { active = false; }
});
if (!app.requestSingleInstanceLock()) app.quit();
else {
  app.on('second-instance', () => { if (win) { if (win.isMinimized()) win.restore(); win.focus(); } });
  app.whenReady().then(() => {
    win = new BrowserWindow({ width: 1360, height: 900, minWidth: 1100, minHeight: 700, title: '曙光送货单打印', autoHideMenuBar: true,
      backgroundColor: '#f3f6fb', webPreferences: { preload: path.join(__dirname, 'preload.cjs'), contextIsolation: true, nodeIntegration: false, sandbox: true } });
    win.webContents.setWindowOpenHandler(() => ({ action: 'deny' }));
    win.webContents.on('will-navigate', e => e.preventDefault());
    win.loadFile(path.join(__dirname, 'index.html'));
  });
  app.on('window-all-closed', () => app.quit());
}
