'use strict';

const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const { createHash, randomUUID } = require('node:crypto');
const { pathToFileURL } = require('node:url');
const ts = require('typescript');
const { validatePrintJob, printOptions } = require('../scripts/dot-matrix-native.cjs');

const templatePath = path.resolve(__dirname, '..', 'src', 'utils', 'dot-matrix-print.ts');
const builtEntry = path.resolve(__dirname, '..', 'dist', 'index.html');
const applicationUrl = pathToFileURL(fs.existsSync(builtEntry) ? builtEntry : path.resolve(__dirname, '..', 'www', 'index.html')).href;
const source = ts.transpileModule(fs.readFileSync(templatePath, 'utf8'), {
  compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2020 }
}).outputText;
const template = { exports: {} };
vm.runInNewContext(source, template, { filename: templatePath });

function errorMessage(error) {
  return error instanceof Error ? error.message : '本机打印失败，请检查打印机后重试';
}

function installLocalPrintBridge({ ipcMain, BrowserWindow, session, getWindow }) {
  const jobs = new Map();
  let active = false;

  const assertSender = event => {
    const win = getWindow();
    const frameUrl = event.senderFrame?.url || '';
    const topLevel = frameUrl === applicationUrl || frameUrl.startsWith(applicationUrl + '#') || frameUrl.startsWith(applicationUrl + '?');
    if (!win || event.sender !== win.webContents || !topLevel) throw new Error('打印请求来源无效');
  };

  const renderJob = async (job, callback) => {
    const isolated = session.fromPartition('warehouse-local-print-' + randomUUID());
    isolated.setPermissionRequestHandler((_contents, _permission, done) => done(false));
    isolated.webRequest.onBeforeRequest((details, done) => done({ cancel: !details.url.startsWith('data:text/html') }));
    const renderer = new BrowserWindow({
      show: false,
      webPreferences: { session: isolated, sandbox: true, contextIsolation: true, nodeIntegration: false }
    });
    renderer.webContents.setWindowOpenHandler(() => ({ action: 'deny' }));
    renderer.webContents.on('will-navigate', event => event.preventDefault());
    try {
      const html = template.exports.buildDotMatrixHtml(job.document, job.settings);
      await renderer.loadURL('data:text/html;charset=utf-8,' + encodeURIComponent(html));
      const layout = await renderer.webContents.executeJavaScript(
        `(async()=>{const exports={};${source}\nawait document.fonts.ready;return exports.paginateDotMatrixDocument(document,${JSON.stringify(job.document)},${JSON.stringify(job.settings)});})()`
      );
      return await callback(renderer.webContents, layout);
    } finally {
      renderer.destroy();
    }
  };

  const listPrinters = async event => {
    assertSender(event);
    const win = getWindow();
    const printers = await win.webContents.getPrintersAsync();
    return printers.map(printer => {
      const offline = Boolean(printer.status & (0x80 | 0x1000));
      const unavailable = offline || Boolean(printer.status & 0x2);
      return {
        name: printer.name,
        displayName: printer.displayName || printer.name,
        isDefault: Boolean(printer.isDefault),
        offline,
        unavailable,
        isPdf: /(?:print|save).*pdf|microsoft print to pdf/i.test(printer.name)
      };
    });
  };

  const sendPrint = async (event, input) => {
    assertSender(event);
    const job = validatePrintJob(input);
    const signature = createHash('sha256').update(JSON.stringify(job)).digest('hex');
    const previous = jobs.get(job.id);
    if (previous) {
      if (previous.signature !== signature) throw new Error('打印任务编号已使用，请重新打开单据');
      return previous.promise;
    }
    if (active) throw new Error('已有打印任务正在发送，请稍后再试');
    if (jobs.size >= 200) jobs.clear();
    active = true;
    const promise = (async () => {
      const win = getWindow();
      const printers = await win.webContents.getPrintersAsync();
      const printer = printers.find(item => item.name === job.printerName);
      if (!printer) throw new Error('所选打印机未连接或未安装');
      if (printer.status & (0x80 | 0x1000 | 0x2)) throw new Error('打印机离线或存在错误，请检查连接和纸张');
      const isPdf = /(?:print|save).*pdf|microsoft print to pdf/i.test(printer.name);
      if (isPdf) {
        return renderJob(job, async (contents, layout) => {
          const pdf = await contents.printToPDF({
            preferCSSPageSize: true,
            printBackground: false,
            displayHeaderFooter: false
          });
          return { kind: 'pdf', printerName: printer.name, pages: layout.pages, pdf: pdf.toString('base64') };
        });
      }
      return renderJob(job, async (contents, layout) => {
        await new Promise((resolve, reject) => {
          contents.print(printOptions(printer.name, job.settings), (ok, reason) => {
            if (ok) resolve();
            else reject(new Error('打印未被接受：' + (reason || '请检查打印队列')));
          });
        });
        return { kind: 'queued', printerName: printer.name, pages: layout.pages };
      });
    })().finally(() => { active = false; });
    jobs.set(job.id, { signature, promise });
    return promise;
  };

  ipcMain.handle('warehouse-local-print:list', async event => {
    try {
      return await listPrinters(event);
    } catch (error) {
      throw new Error(errorMessage(error));
    }
  });
  ipcMain.handle('warehouse-local-print:send', async (event, input) => {
    try {
      return await sendPrint(event, input);
    } catch (error) {
      throw new Error(errorMessage(error));
    }
  });
}

module.exports = { installLocalPrintBridge };
