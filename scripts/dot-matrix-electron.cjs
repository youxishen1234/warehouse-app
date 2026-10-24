// A hidden renderer. Only trusted local code and validated document data enter it.
// It runs one job per process by default. With `--resident` the receiver reuses
// it, but every job still gets its own hidden window and isolated session.
const { app, BrowserWindow, session } = require('electron');
const fs = require('node:fs');
const path = require('node:path');
const Module = require('node:module');
const ts = require('typescript');
const crypto = require('node:crypto');
const http = require('node:http');
const { execFile } = require('node:child_process');
const { promisify } = require('node:util');
const { validatePrintJob, printOptions, fail } = require('./dot-matrix-native.cjs');
const inputFile = process.argv[2];
const resident = inputFile === '--resident';
if (!resident) app.setPath('userData', path.join(path.dirname(inputFile), 'profile'));
app.commandLine.appendSwitch('disable-gpu');

async function run(input) {
  let window;
  let submitted = false;
  try {
    if (!['list', 'print', 'verify'].includes(input.action)) throw fail('无效打印操作');
    const isolated = session.fromPartition('dot-matrix-local-' + Math.random().toString(36).slice(2));
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
    if (input.action === 'list') return { ok: true, data: printers };
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
      return { ok: true, data: { printerName: printer.name, pages: layout.pages, options, kind: 'pdf', pdf: pdf.toString('base64') } };
    }
    submitted = true;
    await new Promise((resolve, reject) => contents.print(options, (success, reason) => {
      if (success) resolve();
      else reject(fail(`打印机未接受任务：${reason || '请检查打印机连接和队列'}`, 'PRINT_REJECTED', false));
    }));
    return { ok: true, data: { printerName: printer.name, pages: layout.pages, kind: 'queued' } };
  } catch (error) {
    return { ok: false, message: error.message || '本机打印失败', code: error.code || 'PRINT_ERROR', safeToRetry: error.safeToRetry ?? !submitted };
  } finally {
    if (window && !window.isDestroyed()) window.destroy();
  }
}

if (resident) {
  // Electron consumes stdin on Windows, so the parent talks to a loopback-only
  // server instead. The port and capability come back on stdout once; the
  // parent enforces each job's timeout and replaces this process if it hangs.
  const capability = crypto.randomBytes(32).toString('hex');
  let queue = Promise.resolve();
  // Electron quits once the last window closes unless the app keeps itself
  // alive; this process must outlive each one-job window.
  app.on('window-all-closed', () => {});
  const server = http.createServer((request, response) => {
    if (request.method !== 'POST' || request.headers['x-render-token'] !== capability) {
      response.writeHead(403).end(); return;
    }
    let body = '';
    request.setEncoding('utf8');
    request.on('data', chunk => { body += chunk; if (body.length > 8 * 1024 * 1024) request.destroy(); });
    request.on('end', () => {
      let message;
      try { message = JSON.parse(body); } catch { response.writeHead(400).end(); return; }
      queue = queue.then(async () => {
        let result;
        try { result = await run(message.request || {}); }
        catch (error) { result = { ok: false, message: error.message || '本机打印失败', code: 'NATIVE_START', safeToRetry: true }; }
        response.writeHead(200, { 'Content-Type': 'application/json' }).end(JSON.stringify(result));
      });
    });
  });
  app.whenReady().then(() => new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => resolve(`WAREHOUSE_PRINT_READY:${server.address().port}:${capability}`));
  })).then(line => process.stdout.write(line + '\n')).catch(error => {
    process.stdout.write(`WAREHOUSE_PRINT_RESULT:${JSON.stringify({ ok: false, message: error.message, code: 'NATIVE_START', safeToRetry: true })}\n`, () => process.exit(1));
  });
} else {
  app.whenReady().then(async () => {
    let result;
    try {
      if (fs.statSync(inputFile).size > 1024 * 1024) throw fail('打印资料过大');
      result = await run(JSON.parse(fs.readFileSync(inputFile, 'utf8')));
    } catch (error) {
      result = { ok: false, message: error.message || '本机打印失败', code: error.code || 'NATIVE_START', safeToRetry: true };
    }
    process.stdout.write(`WAREHOUSE_PRINT_RESULT:${JSON.stringify(result)}\n`, () => app.quit());
  }).catch(error => {
    process.stdout.write(`WAREHOUSE_PRINT_RESULT:${JSON.stringify({ ok: false, message: error.message, code: 'NATIVE_START', safeToRetry: true })}\n`, () => app.quit());
  });
}
