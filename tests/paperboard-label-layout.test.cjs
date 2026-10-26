const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const Module = require('node:module');
const fs = require('node:fs');
const ts = require('typescript');
const { buildLabelHtml } = require('../scripts/k3-layout.cjs');

const batchId = 'BOARD-20261025-A1B2C3D4E5F6';
const batchUrl = `https://youxishen.online/#/pages/label-resolver/index?v=1&kind=paperboard-batch&id=${batchId}`;
const profile = {
  widthMm: 70, heightMm: 100,
  marginMm: { top: 0.6, right: 0.5, bottom: 0.5, left: 0.5 },
};
const data = {
  batchId, batchUrl, boardLength: 120, boardWidth: 100, fluteType: 'BC', supplier: '板厂',
  customerName: '曙光包装', material: '五层 BC 瓦楞纸板', printPlate: 'A款彩印版', printColor: '红·黑',
  receivedQty: 15, remainingQtySnapshot: 0, receivedDate: '2026-10-25',
};

function loadRemoteLayout() {
  const filename = path.resolve('src/features/label-print/remote-layout.ts');
  const loaded = new Module(filename, module);
  loaded.filename = filename;
  loaded.paths = module.paths;
  loaded.require = request => {
    if (request.endsWith('.woff2')) return { default: `data:font/woff2;base64,TEST_${path.basename(request)}` };
    if (request === 'qrcode') return { default: module.require(request) };
    return module.require(request);
  };
  loaded._compile(ts.transpileModule(fs.readFileSync(filename, 'utf8'), {
    compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2020 },
  }).outputText, filename);
  return loaded.exports;
}

function assertApprovedFieldOrder(html) {
  const positions = ['data-field="customer"', 'data-field="spec"', 'data-field="material"', 'data-field="plate"']
    .map(marker => html.indexOf(marker));
  assert.ok(positions.every(position => position >= 0), 'all four approved business fields appear');
  assert.deepEqual(positions, positions.slice().sort((a, b) => a - b), 'business fields appear in approved order');
}

test('K3 and phone preview share 70×100 business fields, source fonts, QR and explicit zero quantity', async () => {
  const k3 = await buildLabelHtml({ kind: 'paperboard-batch', data, profile });
  assert.deepEqual(k3.warnings, []);
  assertApprovedFieldOrder(k3.html);
  assert.match(k3.html, /纸板规格|规格 · 长 × 宽（cm）/);
  assert.match(k3.html, /印刷版 · 版名 \/ 颜色/);
  assert.match(k3.html, /红·黑/);
  assert.match(k3.html, /数量：0 张/);
  assert.match(k3.html, /日期：2026-10-25/);
  assert.match(k3.html, new RegExp(`批次：${batchId}`));
  assert.match(k3.html, /<div class="paperboard-qr" data-qr><img src="data:image\/png;base64,/);
  assert.match(k3.html, /data-fit data-field="customer"/);
  assert.match(k3.html, /@font-face\{font-family:PaperboardSourceHan;src:url\(data:font\/woff2;base64,/);
  assert.match(k3.html, /\.paperboard-qr\{width:192px;height:192px/);
  assert.equal(k3.html.includes('版号'), false, 'the retired plate-number field is not reintroduced');

  const remote = loadRemoteLayout();
  const phone = await remote.buildRemoteLabelHtml({ kind: 'paperboard-batch', profile, copies: 1, data });
  assert.deepEqual(phone.warnings, []);
  assertApprovedFieldOrder(phone.html);
  assert.match(phone.html, /数量：0 张/);
  assert.match(phone.html, /font-src 'self' data:/);
  assert.match(phone.html, /font-family:PaperboardSourceHan;src:url\("data:font\/woff2;base64,TEST_SourceHanSansSC-Heavy.woff2"\)/);
  assert.match(phone.html, /width:24mm;height:24mm/);
});

test('legacy empty fields display 未填写, long business text remains fit-checked, and other sizes keep old layout', async () => {
  const empty = await buildLabelHtml({
    kind: 'paperboard-batch',
    profile,
    data: { ...data, customerName: '', material: '', printPlate: '', printColor: '', receivedQty: undefined, remainingQtySnapshot: undefined, receivedDate: '' },
  });
  assert.match(empty.html, /data-field="customer">未填写/);
  assert.match(empty.html, /data-field="material">未填写/);
  assert.match(empty.html, /data-field="plate">未填写/);
  assert.match(empty.html, /数量：未填写 张/);
  assert.match(empty.html, /日期：未填写/);
  assert.match(empty.html, /data-fit/);
  assert.deepEqual(empty.warnings, []);

  const long = await buildLabelHtml({
    kind: 'paperboard-batch', profile,
    data: { ...data, customerName: '客户名称'.repeat(30) },
  });
  assert.match(long.html, /data-fit data-field="customer"/);
  assert.match(long.html, /max-height:2\.5em;overflow:visible/);

  const otherPaper = await buildLabelHtml({
    kind: 'paperboard-batch',
    profile: { ...profile, widthMm: 58 },
    data,
  });
  assert.match(otherPaper.html, /纸板规格/);
  assert.equal(otherPaper.html.includes('SourceHanSansSC-Heavy'), false);
  assert.ok(otherPaper.html.length < 100000, 'other paper sizes do not embed the full board font payload');

  const product = await buildLabelHtml({
    kind: 'finished-product',
    profile,
    data: { productId: 3, productUrl: 'https://youxishen.online/#/pages/label-resolver/index?v=1&kind=finished-product&id=3', name: '成品纸箱', specification: '70 × 100 mm', unit: '个' },
  });
  assert.match(product.html, /成品标签/);
  assert.equal(product.html.includes('SourceHanSansSC-Heavy'), false);
});
