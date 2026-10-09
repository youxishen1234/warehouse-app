const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const Module = require('node:module');
const test = require('node:test');
const ts = require('typescript');

const filename = path.resolve('src/utils/dot-matrix-print.ts');
const loaded = new Module(filename, module);
loaded.filename = filename;
loaded.paths = module.paths;
loaded._compile(ts.transpileModule(fs.readFileSync(filename, 'utf8'), { compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2020 } }).outputText, filename);
const { normalizePrintSettings, DEFAULT_PRINT_SETTINGS, documentFromTransactions, transactionPrintKey, samplePrintDocument, buildDotMatrixHtml, moneyUpper } = loaded.exports;

const line = (id, changes = {}) => ({ id, product_id: 3, type: 'out', outbound_no: 'CK-008', customer_id: 4, customer_name: '历史客户名称', created_at: 1790985600000, quantity: 2, unit: '个', unit_price: 1.25, amount: 2.5, operator: '经手人', remark: '', ...changes });

test('one outbound document preserves its original transaction snapshots and orders every line', () => {
  const doc = documentFromTransactions([line(2), line(1)]);
  assert.deepEqual(doc.lines.map(item => item.id), [1, 2]);
  assert.equal(doc.party, '历史客户名称');
  assert.equal(doc.number, 'CK-008');
  assert.equal(doc.lines[0].unit_price, 1.25);
  assert.throws(() => documentFromTransactions([line(1), line(2, { outbound_no: 'CK-009' })]), /同一张/);
  assert.throws(() => documentFromTransactions([line(1), line(2, { customer_id: 6 })]), /同一张/);
  assert.throws(() => documentFromTransactions([line(1), line(1)]), /重复明细/);
  assert.throws(() => documentFromTransactions([line(1, { voided_at: 100 })]), /作废/);
  assert.throws(() => documentFromTransactions([line(1, { type: 'adjustment' })]), /盘点/);
  assert.throws(() => documentFromTransactions([]), /没有/);
});

test('ungrouped historical entries and incoming records stay separate', () => {
  assert.notEqual(transactionPrintKey(line(1, { outbound_no: undefined })), transactionPrintKey(line(2, { outbound_no: undefined })));
  const doc = documentFromTransactions([line(1, { type: 'in', outbound_no: undefined, supplier_name: '原供应商', supplier_id: 3 })]);
  assert.equal(doc.title, '入 库 凭 证');
  assert.equal(doc.party, '原供应商');
  assert.equal(doc.number, 'RK-1');
});

test('physical paper dimensions and calibration are bounded even for corrupt saved settings', () => {
  assert.deepEqual(normalizePrintSettings(null), DEFAULT_PRINT_SETTINGS);
  assert.equal(normalizePrintSettings({ template: 'blank', paper: '241-93', width: 0 }).height, 93);
  const result = normalizePrintSettings({ template: 'blank', paper: 'custom', width: NaN, height: 99999, offsetX: Infinity, offsetY: -100, fontSize: 3, rowsPerPage: 3.8, showPrices: 'false' });
  assert.equal(result.width, 241); assert.equal(result.height, 400);
  assert.equal(result.offsetX, 0); assert.equal(result.offsetY, -5);
  assert.equal(result.fontSize, 10); assert.equal(result.rowsPerPage, 4); assert.equal(result.showPrices, true);
  assert.equal(result.highClarity, true);
  assert.equal(normalizePrintSettings({ template: 'blank', highClarity: false, fontSize: 3 }).fontSize, 9);
  assert.equal(normalizePrintSettings({ company: '<'.repeat(100) }).company.length, 50);
  assert.equal(normalizePrintSettings({ template: 'outbound-four', paper: '241-140', height: 140 }).paper, '241-93');
  assert.equal(normalizePrintSettings({ template: 'outbound-four', paper: '241-140', height: 140 }).height, 93);
});

test('preprinted outbound template contains only variable overlays and keeps guide out of physical print', () => {
  const html = buildDotMatrixHtml(samplePrintDocument(), { ...DEFAULT_PRINT_SETTINGS, template: 'preprinted-outbound' });
  assert.match(html, /preprinted-guide/);
  assert.match(html, /pre-row/);
  assert.doesNotMatch(html, /<table/);
  assert.match(html, /测试样张 · 不作为发货凭证/);
  assert.match(html, /\.preprinted-guide\{display:none\}/);
});

test('printed amounts use stored cents, missing amounts stay unknown, and hidden prices leave no amounts in the HTML', () => {
  const doc = documentFromTransactions([line(1, { amount: .1 }), line(2, { amount: .2 })]);
  assert.match(buildDotMatrixHtml(doc, { ...DEFAULT_PRINT_SETTINGS, template: 'blank' }), /￥ 0\.30/);
  const missing = documentFromTransactions([line(1, { amount: undefined, unit_price: undefined })]);
  assert.match(buildDotMatrixHtml(missing, { ...DEFAULT_PRINT_SETTINGS, template: 'blank' }), /金额未完整记录/);
  const hidden = buildDotMatrixHtml(documentFromTransactions([line(1, { amount: 123456.78, unit_price: 61728.39 })]), { ...DEFAULT_PRINT_SETTINGS, template: 'blank', showPrices: false });
  assert.doesNotMatch(hidden, /123456\.78|61728\.39|单价|金额|大写/);
});

test('stored business text is escaped in all printed fields', () => {
  const attack = '</td><script>parent.alert(1)</script><img src=x onerror=alert(2)>';
  const doc = documentFromTransactions([line(1, { product_name: attack, remark: attack, customer_name: attack, operator: attack, outbound_no: attack })]);
  const html = buildDotMatrixHtml(doc, { ...DEFAULT_PRINT_SETTINGS, template: 'blank', company: attack });
  assert.doesNotMatch(html, /<script|<img|<\/td><script/);
  assert.match(html, /&lt;script&gt;/);
});

test('uppercase currency preserves zeros across ten-thousand and hundred-million groups', () => {
  for (const [amount, text] of [[0, '零元整'], [.01, '零元零壹分'], [.3, '零元叁角'], [790, '柒佰玖拾元整'], [10001, '壹万零壹元整'], [100000001, '壹亿零壹元整'], [100010001.05, '壹亿零壹万零壹元零伍分']]) assert.equal(moneyUpper(amount), text);
  assert.equal(moneyUpper(-1), '金额超出大写支持范围');
});

test('sample clearly identifies itself and mixed units are never added together', () => {
  assert.match(buildDotMatrixHtml(samplePrintDocument(), { ...DEFAULT_PRINT_SETTINGS, template: 'blank' }), /测试样张 · 不作为发货凭证/);
  const html = buildDotMatrixHtml(documentFromTransactions([line(1, { quantity: 2, unit: '个' }), line(2, { quantity: 3, unit: '张' })]), { ...DEFAULT_PRINT_SETTINGS, template: 'blank', showPrices: false });
  assert.match(html, /整单数量：2 个 \/ 3 张/);
});

test('four-row form prints the editable title, preserves all pages, and pads exactly four slots', () => {
  const doc = samplePrintDocument();
  doc.lines = Array.from({ length: 8 }, (_, index) => ({ ...doc.lines[index % 2], id: index + 1, printCode: `ITEM-${index + 1}`, amount: 100 + index }));
  doc.category = '纸箱'; doc.supervisor = '王主管'; doc.warehouse = '李仓管'; doc.accountant = '赵会计';
  const html = buildDotMatrixHtml(doc, { ...DEFAULT_PRINT_SETTINGS, rowsPerPage: 19 });
  assert.equal(normalizePrintSettings({ ...DEFAULT_PRINT_SETTINGS, rowsPerPage: 19 }).rowsPerPage, 4);
  assert.equal((html.match(/class="sheet four-sheet"/g) || []).length, 2);
  assert.equal((html.match(/class="four-cell"/g) || []).length, 8 * 8);
  assert.equal((html.match(/data-line=/g) || []).length, 8);
  assert.match(html, /<h1>东光县曙光纸箱包装出库单<\/h1>/);
  assert.match(html, /出库数量/); assert.match(html, /王主管/); assert.match(html, /ITEM-8/);
  assert.match(html, /￥ 406\.00/); assert.match(html, /￥ 422\.00/);
  assert.doesNotMatch(html, /preprinted-guide/);
  const hidden = buildDotMatrixHtml(doc, { ...DEFAULT_PRINT_SETTINGS, showPrices: false });
  assert.doesNotMatch(hidden, /615\.00|213\.00/);
  const escaped = buildDotMatrixHtml(doc, { ...DEFAULT_PRINT_SETTINGS, template: 'blank', company: '<img src=x>' });
  assert.match(escaped, /&lt;img src=x&gt;/); assert.doesNotMatch(escaped, /<img/);
});
