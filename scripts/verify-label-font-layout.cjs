// Compose native-test text PNGs for layout QA only, never an official SDK preview.
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');
const { chromium } = require('@playwright/test');
const QRCode = require('qrcode');

const root = path.resolve(__dirname, '..');
const input = path.resolve(process.argv[2] || 'release/build-207-watch/native-regression');
const output = path.resolve(process.argv[3] || `release/label-layout-${Date.now()}`);
const read = name => JSON.parse(fs.readFileSync(path.join(input, name), 'utf8'));
const digest = data => crypto.createHash('sha256').update(data).digest('hex');
const scope = 'Native CoreText PNGs and recorded element coordinates; reference QR generated with qrcode. Not an official SDK preview, hardware DPI claim, or physical print test.';

function evidenceFile(name) {
  assert.equal(path.basename(name), name, 'Evidence filename must not escape its directory');
  const filename = path.join(input, name);
  assert.ok(fs.statSync(filename).isFile(), 'Missing native evidence: ' + name);
  return filename;
}

function rect(element, padding = 0) {
  return { left: element.x - padding, top: element.y - padding,
    right: element.x + element.w + padding, bottom: element.y + element.h + padding };
}

function overlaps(a, b) {
  const epsilon = 0.000001;
  return a.left < b.right - epsilon && a.right > b.left + epsilon
    && a.top < b.bottom - epsilon && a.bottom > b.top + epsilon;
}

function prepare(attempt, fixtures) {
  assert.equal(attempt.outcome, 'passed-font-and-layout-to-sdk-stub');
  assert.equal(attempt.sdkStubCalls, 1);
  assert.equal(attempt.sdkVerified, false, 'Do not mislabel stub evidence as SDK output');
  const profile = fixtures.screenshotProfile, margin = profile.marginMm;
  const images = [], occupied = [], codes = [];
  for (const element of attempt.elements) {
    assert.ok(['image', 'line', 'qr'].includes(element.type));
    assert.ok([element.x, element.y, element.w, element.h].every(Number.isFinite));
    assert.ok(element.w > 0 && element.h > 0);
    let padding = 0;
    if (element.type === 'image') {
      const filename = evidenceFile(element.bitmap.png), png = fs.readFileSync(filename);
      assert.equal(element.bitmap.edgeInkPixelsBelow127, 0, 'Native text touches bitmap edge');
      assert.ok(element.bitmap.inkPixelsBelow127 > 0);
      images.push({ field: element.sourceField, text: element.sourceText,
        png: element.bitmap.png, sha256: digest(png) });
    } else if (element.type === 'qr') {
      const matrix = QRCode.create(element.text, { errorCorrectionLevel: 'M' });
      assert.equal(element.w, element.h, 'QR must be square');
      padding = Math.max(2, element.w / matrix.modules.size * 4);
      codes.push({ text: element.text, modules: matrix.modules.size,
        moduleMm: element.w / matrix.modules.size, quietMm: padding,
        quietModules: padding / (element.w / matrix.modules.size), generatedBy: 'qrcode reference, not JCAPI' });
    }
    const bounds = rect(element, padding);
    assert.ok(bounds.left >= margin.left - 0.000001 && bounds.top >= margin.top - 0.000001);
    assert.ok(bounds.right <= profile.widthMm - margin.right + 0.000001);
    assert.ok(bounds.bottom <= profile.heightMm - margin.bottom + 0.000001);
    if (element.type !== 'line') {
      for (const previous of occupied) assert.ok(!overlaps(bounds, previous), 'Text or QR quiet-zone overlap');
      occupied.push(bounds);
    }
  }
  return { images, codes };
}

async function main() {
  const provenance = read('provenance.json'), report = read('report.json'), fixtures = read('fixtures.json');
  assert.equal(report.status, 'completed');
  assert.equal(provenance.sdkTestDouble, true);
  assert.equal(provenance.physicalPrintingTested, false);
  assert.match(provenance.commit, /^[a-f0-9]{40}$/);
  assert.equal(digest(fs.readFileSync(evidenceFile('fixtures.json'))), provenance.fixturesSHA256);
  assert.deepEqual(report.fixtures, fixtures);
  for (const [file, key] of [['ios/App/App/LabelTemplateRenderer.swift', 'rendererSHA256'],
    ['ios/App/App/NIIMBOTSDKAdapter.m', 'adapterSHA256'], ['tests/label-font-fixtures.json', 'fixturesSHA256']]) {
    assert.equal(digest(fs.readFileSync(path.join(root, file))), provenance[key], 'Evidence source mismatch: ' + file);
  }
  assert.equal(report.productionAttempts.length, 3);
  assert.equal(fixtures.testOnly, true);
  const expected = new Set(['calibration-original', ...fixtures.templateCases.map(item => item.id)]);
  assert.deepEqual(new Set(report.productionAttempts.map(item => item.id)), expected);
  assert.ok(output.startsWith(path.join(root, 'release') + path.sep), 'Write QA output only under release/');
  assert.ok(!fs.existsSync(output), 'Use a new output directory; existing evidence is never overwritten');
  const prepared = report.productionAttempts.map(attempt => ({ attempt, ...prepare(attempt, fixtures) }));
  fs.mkdirSync(output, { recursive: true });
  const browser = await chromium.launch();
  const results = [];
  try {
    const page = await browser.newPage();
    await page.route('**/*', route => route.abort());
    await page.addScriptTag({ path: require.resolve('jsqr') });
    for (const { attempt, images, codes } of prepared) {
      const template = fixtures.templateCases.find(item => item.id === attempt.id);
      const text = images.map(item => item.text).join('');
      if (template) {
        for (const token of template.expectedTextTokens) assert.ok(text.includes(token), 'Lost field: ' + token);
        assert.equal(codes.length, 1);
        assert.equal(codes[0].text, template.data.productUrl || template.data.batchUrl);
      } else {
        assert.equal(text, fixtures.calibrationOriginalText);
        assert.equal(codes.length, 0);
      }
      const elements = attempt.elements.map(element => {
        if (element.type === 'image') return { ...element, dataURL: 'data:image/png;base64,'
          + fs.readFileSync(evidenceFile(element.bitmap.png)).toString('base64') };
        if (element.type === 'qr') {
          const qr = QRCode.create(element.text, { errorCorrectionLevel: 'M' });
          return { ...element, modules: qr.modules.size, cells: Array.from(qr.modules.data) };
        }
        return element;
      });
      for (const dpi of [203, 300]) {
        const composed = await page.evaluate(async ({ profile, elements, dpi }) => {
          const pixels = mm => Math.round(mm * dpi / 25.4);
          const canvas = document.createElement('canvas');
          canvas.width = Math.ceil(profile.widthMm * dpi / 25.4);
          canvas.height = Math.ceil(profile.heightMm * dpi / 25.4);
          const ctx = canvas.getContext('2d', { alpha: false });
          ctx.fillStyle = '#fff'; ctx.fillRect(0, 0, canvas.width, canvas.height);
          ctx.imageSmoothingEnabled = true;
          ctx.imageSmoothingQuality = 'high';
          for (const element of elements) {
            const x = pixels(element.x), y = pixels(element.y);
            const w = pixels(element.x + element.w) - x, h = pixels(element.y + element.h) - y;
            if (element.type === 'image') {
              const image = new Image(); image.src = element.dataURL; await image.decode();
              ctx.drawImage(image, x, y, w, h);
            } else if (element.type === 'line') {
              ctx.fillStyle = '#000'; ctx.fillRect(x, y, Math.max(1, w), Math.max(1, h));
            } else {
              ctx.fillStyle = '#000';
              for (let row = 0; row < element.modules; row++) {
                for (let col = 0; col < element.modules; col++) {
                  if (!element.cells[row * element.modules + col]) continue;
                  const left = x + Math.round(col * w / element.modules), top = y + Math.round(row * h / element.modules);
                  ctx.fillRect(left, top, x + Math.round((col + 1) * w / element.modules) - left,
                    y + Math.round((row + 1) * h / element.modules) - top);
                }
              }
            }
          }
          const png = canvas.toDataURL('image/png');
          const image = ctx.getImageData(0, 0, canvas.width, canvas.height);
          for (let i = 0; i < image.data.length; i += 4) {
            const value = image.data[i] < 127 ? 0 : 255;
            image.data[i] = image.data[i + 1] = image.data[i + 2] = value;
          }
          ctx.putImageData(image, 0, 0);
          const qr = window.jsQR(image.data, canvas.width, canvas.height, { inversionAttempts: 'dontInvert' });
          return { png, thresholdPNG: canvas.toDataURL('image/png'), width: canvas.width, height: canvas.height,
            decodedQR: qr?.data || null };
        }, { profile: fixtures.screenshotProfile, elements, dpi });
        assert.equal(composed.decodedQR, codes[0]?.text || null, 'Full label QR does not decode');
        const png = `${attempt.id}-${dpi}dpi-reference.png`, binaryPNG = `${attempt.id}-${dpi}dpi-threshold127.png`;
        for (const [filename, data] of [[png, composed.png], [binaryPNG, composed.thresholdPNG]]) {
          fs.writeFileSync(path.join(output, filename), Buffer.from(data.split(',')[1], 'base64'));
        }
        results.push({ id: attempt.id, dpiReferenceOnly: dpi, widthPx: composed.width, heightPx: composed.height,
          png, binaryPNG, textImages: images, referenceQR: codes, decodedQR: composed.decodedQR,
          overlap: false, businessWrites: 0, sdkExecuted: false, physicalPrintingTested: false });
        console.log(`PASS ${attempt.id} at ${dpi} reference dpi: bounds, overlap and fields; QR ${codes.length ? 'decoded' : 'not present'}`);
      }
    }
  } finally { await browser.close(); }
  const result = { checkedAt: new Date().toISOString(), sourceCommit: provenance.commit, scope,
    status: 'reference-layout-passed-device-acceptance-still-required', results };
  fs.writeFileSync(path.join(output, 'layout-results.json'), JSON.stringify(result, null, 2) + '\n');
  console.log('Reference images and results:', output);
}

main().catch(error => { console.error(error); process.exitCode = 1; });
