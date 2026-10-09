// A hidden, one-job renderer. Only trusted local code and validated document data enter it.
const { app, BrowserWindow, session } = require('electron');
const fs = require('node:fs');
const path = require('node:path');
const Module = require('node:module');
const ts = require('typescript');
const { execFile } = require('node:child_process');
const { promisify } = require('node:util');
const { validatePrintJob, printOptions, fail } = require('./dot-matrix-native.cjs');
const inputFile = process.argv[2];
app.setPath('userData', path.join(path.dirname(inputFile), 'profile'));
app.commandLine.appendSwitch('disable-gpu');

function reply(result) {
  process.stdout.write(`WAREHOUSE_PRINT_RESULT:${JSON.stringify(result)}\n`, () => app.quit());
}

app.whenReady().then(async () => {
  let window;
  let submitted = false;
  try {
    if (fs.statSync(inputFile).size > 1024 * 1024) throw fail('打印资料过大');
    const input = JSON.parse(fs.readFileSync(inputFile, 'utf8'));
    if (!['list', 'print', 'verify'].includes(input.action)) throw fail('无效打印操作');
    const isolated = session.fromPartition('dot-matrix-local');
    isolated.setPermissionRequestHandler((_, __, callback) => callback(false));
    isolated.webRequest.onBeforeRequest((details, callback) => callback({ cancel: !details.url.startsWith('data:text/html') }));
    window = new BrowserWindow({ show: false, width: 1280, height: 1000,
      webPreferences: { session: isolated, contextIsolation: true, nodeIntegration: false, sandbox: true, backgroundThrottling: false } });
    const contents = window.webContents;
    contents.setWindowOpenHandler(() => ({ action: 'deny' }));
    contents.on('will-navigate', event => event.preventDefault());
    // Electron's status can be zero even when Windows has "Use Printer Offline" set.
    let windowsPrinters = [];
    if (process.platform === 'win32') {
      const { stdout } = await promisify(execFile)('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command',
        '[Console]::OutputEncoding = [System.Text.UTF8Encoding]::new(); @(Get-CimInstance Win32_Printer | Select-Object Name,WorkOffline,PrinterStatus) | ConvertTo-Json -Compress'],
      { windowsHide: true, timeout: 10000, maxBuffer: 1024 * 1024 });
      const result = JSON.parse(stdout || '[]');
      windowsPrinters = Array.isArray(result) ? result : [result];
    }
    const printers = (await contents.getPrintersAsync()).map(printer => {
      const windows = windowsPrinters.find(item => item.Name === printer.name);
      const offline = Boolean(windows?.WorkOffline || windows?.PrinterStatus === 7 || printer.status & 0x80);
      return {
      name: printer.name, displayName: printer.displayName || printer.name, isDefault: printer.isDefault,
      offline,
      unavailable: offline || Boolean(printer.status & (0x1000 | 0x2)),
      isPdf: printer.name === 'Microsoft Print to PDF',
      };
    });
    if (input.action === 'list') return reply({ ok: true, data: printers });
    const job = validatePrintJob(input.job);
    const printer = printers.find(item => item.name === job.printerName);
    if (!printer) throw fail('所选打印机已移除，请刷新打印机列表重新选择', 'PRINTER_MISSING');
    if (printer.unavailable) throw fail(`${printer.name} 当前离线或不可用，请连接后刷新打印机列表`, 'PRINTER_OFFLINE');

    const filename = path.resolve(__dirname, '../src/utils/dot-matrix-print.ts');
    const source = ts.transpileModule(fs.readFileSync(filename, 'utf8'), {
      compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2020 },
    }).outputText;
    const loaded = new Module(filename, module);
    loaded._compile(source, filename);
    const settings = loaded.exports.normalizePrintSettings(job.settings);
    const html = loaded.exports.buildDotMatrixHtml(job.document, settings).replace('<head>', '<head><meta http-equiv="Content-Security-Policy" content="default-src \'none\'; style-src \'unsafe-inline\'; script-src \'none\'; base-uri \'none\'; form-action \'none\'">');
    await window.loadURL(`data:text/html;charset=utf-8,${encodeURIComponent(html)}`);
    const layout = await contents.executeJavaScript(`(async () => { const exports = {}; ${source}\n await document.fonts.ready; return exports.paginateDotMatrixDocument(document, ${JSON.stringify(job.document)}, ${JSON.stringify(settings)}); })()`);
    let supportedDpi;
    if (process.platform === 'win32' && settings.highClarity && printer.name === 'EPSON LQ-630KII ESC/P2') {
      // Read supported driver capabilities. Never send a guessed 600/1200 dpi to a needle printer.
      const { stdout } = await promisify(execFile)('powershell.exe', ['-NoProfile', '-NonInteractive', '-File',
        path.join(__dirname, 'set-dot-matrix-quality.ps1'), '-PrinterName', printer.name],
      { windowsHide: true, timeout: 10000, maxBuffer: 1024 * 1024 });
      const quality = JSON.parse(stdout);
      supportedDpi = { horizontal: quality.Requested.DpiX, vertical: quality.Requested.DpiY };
    }
    const options = printOptions(printer.name, settings, supportedDpi);
    if (input.action === 'verify' || printer.isPdf) {
      // Verification and the PDF card never call the physical printer API.
      const pdf = await contents.printToPDF({ preferCSSPageSize: true, printBackground: false, displayHeaderFooter: false,
        margins: { top: 0, bottom: 0, left: 0, right: 0 }, scale: 1 });
      return reply({ ok: true, data: { printerName: printer.name, pages: layout.pages, options, kind: 'pdf', pdf: pdf.toString('base64') } });
    }
    submitted = true;
    await new Promise((resolve, reject) => contents.print(options, (success, reason) => {
      if (success) resolve();
      else reject(fail(`打印机未接受任务：${reason || '请检查打印机连接和队列'}`, 'PRINT_REJECTED', false));
    }));
    reply({ ok: true, data: { printerName: printer.name, pages: layout.pages, kind: 'queued' } });
  } catch (error) {
    reply({ ok: false, message: error.message || '本机打印失败', code: error.code || 'PRINT_ERROR', safeToRetry: error.safeToRetry ?? !submitted });
  }
}).catch(error => reply({ ok: false, message: error.message, code: 'NATIVE_START', safeToRetry: true }));
