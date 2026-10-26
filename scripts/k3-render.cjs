// Hidden Electron window: render one label to PNG, then to 1-bit printer rows.
const { app, BrowserWindow, session } = require('electron');
const fs = require('node:fs');
const path = require('node:path');
const { pathToFileURL } = require('node:url');
const { PNG } = require('pngjs');
const { buildLabelHtml, buildCalibrationHtml } = require('./k3-layout.cjs');

const inputFile = process.argv[2];
const reply = result => {
  process.stdout.write(`K3_RENDER_RESULT:${JSON.stringify(result)}\n`, () => app.quit());
};

function toRows(png) {
  const threshold = 168;
  const rowBytes = Math.ceil(png.width / 8);
  const rows = Buffer.alloc(rowBytes * png.height);
  for (let y = 0; y < png.height; y += 1) {
    for (let x = 0; x < png.width; x += 1) {
      const offset = (y * png.width + x) * 4;
      const alpha = png.data[offset + 3] / 255;
      const luminance = (0.299 * png.data[offset] + 0.587 * png.data[offset + 1] + 0.114 * png.data[offset + 2]) * alpha + 255 * (1 - alpha);
      if (luminance < threshold) rows[y * rowBytes + (x >> 3)] |= 0x80 >> (x & 7);
    }
  }
  return rows;
}

app.commandLine.appendSwitch('disable-gpu');
app.commandLine.appendSwitch('force-device-scale-factor', '1');

app.whenReady().then(async () => {
  let window;
  try {
    const job = JSON.parse(fs.readFileSync(inputFile, 'utf8'));
    const { profile, kind, data } = job;
    if (!profile) throw new Error('缺少纸张配置');
    const width = Math.round(profile.widthMm * 8);
    const height = Math.round(profile.heightMm * 8);
    if (!(width >= 80 && width <= 656 && height >= 80 && height <= 12000)) throw new Error('标签尺寸超出 K3 打印头范围');

    const rendered = kind === 'calibration' ? await buildCalibrationHtml({ profile }) : await buildLabelHtml({ kind, data, profile });
    const isolated = session.fromPartition('k3-label-local');
    isolated.setPermissionRequestHandler((_wc, _permission, callback) => callback(false));
    const htmlFile = path.join(path.dirname(inputFile), 'label.html');
    fs.writeFileSync(htmlFile, rendered.html, { encoding: 'utf8', mode: 0o600 });
    const allowedHtmlUrl = pathToFileURL(htmlFile).href;
    isolated.webRequest.onBeforeRequest((details, callback) => callback({
      cancel: !details.url.startsWith('data:') && details.url !== allowedHtmlUrl,
    }));
    window = new BrowserWindow({
      show: false, width: Math.max(800, width + 40), height: Math.max(1000, height + 40),
      webPreferences: { session: isolated, contextIsolation: true, nodeIntegration: false, sandbox: true, backgroundThrottling: false, deviceScaleFactor: 1 },
    });
    window.webContents.setWindowOpenHandler(() => ({ action: 'deny' }));
    window.webContents.on('will-navigate', event => event.preventDefault());
    await window.loadFile(htmlFile);
    await window.webContents.executeJavaScript('document.fonts.ready.then(() => new Promise(r => requestAnimationFrame(() => requestAnimationFrame(r))))');
    const overflowFields = await window.webContents.executeJavaScript(`Array.from(document.querySelectorAll('[data-fit]'))
      .filter(element => {
        const maxHeight = parseFloat(getComputedStyle(element).maxHeight);
        const verticalOverflow = element.classList.contains('paperboard-value')
          ? Number.isFinite(maxHeight) && element.scrollHeight > maxHeight + 2
          : element.scrollHeight > element.clientHeight + 2;
        return element.scrollWidth > element.clientWidth + 2 || verticalOverflow;
      })
      .map(element => element.dataset.field || '纸板标签整体')`);
    if (overflowFields.length) {
      rendered.warnings = [...new Set([...(rendered.warnings || []), ...overflowFields.map(field => `标签字段「${field}」超出可打印范围；已停止打印`)])];
    }

    const image = await window.webContents.capturePage({ x: 0, y: 0, width, height });
    const png = PNG.sync.read(image.toPNG());
    if (png.width < width || png.height < height) {
      throw new Error(`截图尺寸不足（${png.width}×${png.height}）`);
    }
    const cropped = png.width === width && png.height === height ? png : (() => {
      const target = new PNG({ width, height });
      png.bitblt(target, 0, 0, width, height, 0, 0);
      return target;
    })();
    const outputPng = job.outputPng || path.join(path.dirname(inputFile), 'label.png');
    fs.mkdirSync(path.dirname(outputPng), { recursive: true });
    fs.writeFileSync(outputPng, PNG.sync.write(cropped));
    const rows = toRows(cropped);
    const black = cropBlackPixels(cropped);
    reply({
      ok: true, width, height, rowsBase64: rows.toString('base64'),
      pngPath: outputPng, warnings: rendered.warnings || [],
      blackPixels: black, pixelRatio: Number((black / (width * height)).toFixed(5)),
    });
  } catch (error) {
    reply({ ok: false, message: error && error.message ? error.message : String(error) });
  } finally {
    if (window) { try { window.destroy(); } catch { /* already gone */ } }
  }
}).catch(error => reply({ ok: false, message: error.message }));

function cropBlackPixels(png) {
  let count = 0;
  for (let index = 0; index < png.data.length; index += 4) {
    if (png.data[index] < 168) count += 1;
  }
  return count;
}
