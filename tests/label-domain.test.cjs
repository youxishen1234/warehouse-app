const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const Module = require('node:module');
const ts = require('typescript');
function load(name, stubs = {}, cache = new Map()) {
  const filename = path.resolve('src/features/label-print', `${name}.ts`);
  if (cache.has(filename)) return cache.get(filename).exports;
  const loaded = new Module(filename, module); loaded.filename = filename; loaded.paths = module.paths; cache.set(filename, loaded);
  loaded.require = request => {
    if (Object.hasOwn(stubs, request)) return stubs[request];
    if (request.startsWith('./')) return load(request.slice(2), stubs, cache);
    return module.require(request);
  };
  loaded._compile(ts.transpileModule(fs.readFileSync(filename, 'utf8'), { compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2020 } }).outputText, filename);
  return loaded.exports;
}
const links = load('links');
const domain = load('model');
const batchId = 'BOARD-20261016-A1B2C3D4E5F6';
const product = (overrides = {}) => ({ id: 7, name: '成品纸箱', category: '纸箱', specification: '420 × 260 × 180 mm', unit: '箱', price: 99, stock: 0, safety_stock: 2, created_at: 1, updated_at: 2, material: '牛卡', corrugation: 'AB', layers: 5, weight: 180, length: 420, width: 260, phone: 'private', remark: 'private', ...overrides });
const board = (overrides = {}) => ({ id: batchId, specKey: 'internal', supplier: '纸板厂', boardLength: 120.5, boardWidth: 80, fluteType: 'AB', layers: 5, faceGsm: 180, linerGsm: 150, flutingGsm: 120, cartonLength: 42, cartonWidth: 26, cartonHeight: 18, orderedQty: 20, receivedQty: 0, remainingQty: 0, giftQty: 0, shortageQty: 20, billedArea: 99, unitPrice: 88, amount: 1234, date: '2026-10-16', deliveryNo: 'private', location: 'A-1', remark: 'private', warningQty: 10, createdAt: 1, movements: [], ...overrides });
const problem = (run, field) => assert.throws(run, error => error instanceof domain.LabelValidationError && error.issues[0].field === field);

test('new QR URLs round trip with fixed HTTPS origin, hash route and version', () => {
  assert.equal(links.buildLabelUrl('finished-product', 7), 'https://youxishen.online/#/pages/label-resolver/index?v=1&kind=finished-product&id=7');
  for (const [kind, id] of [['finished-product', '7'], ['paperboard-batch', batchId]]) {
    assert.deepEqual(links.parseLabelUrl(links.buildLabelUrl(kind, id)), { version: 1, kind, id });
    assert.equal(Object.isFrozen(links.parseLabelUrl(links.buildLabelUrl(kind, id))), true);
  }
  assert.equal(links.parseLabelUrl('https://youxishen.online/#/pages/label-resolver/index?id=7&v=1&kind=finished-product').id, '7');
});

test('reject forged hosts, paths, credentials, versions, duplicate and unknown parameters', () => {
  const url = links.buildLabelUrl('finished-product', 7);
  const invalid = [url.replace('https:', 'http:'), url.replace('youxishen.online', 'youxishen.online.evil.test'),
    url.replace('youxishen.online', 'evil.test@youxishen.online'), url.replace('youxishen.online', 'youxishen.online:443'),
    url.replace('/#/', '/warehouse/#/'), url.replace('/#/', '/?untrusted=1#/'), url.replace('label-resolver', 'products'),
    url.replace('v=1', 'v=2'), url.replace('v=1', 'v=01'), url.replace('v=1', 'v=1&v=1'), url + '&x=1',
    url.replace('kind=finished-product', 'kind=product'), url.replace('&id=7', ''), url + '#suffix', url + '?next=1',
    ' ' + url, url + ' ', url.replace('v=1', '%76=1'), url.replace('&id=7', '&id=7&id=8'), url.replace('id=7', 'id=' + String.fromCharCode(10) + '7')];
  invalid.forEach(value => assert.throws(() => links.parseLabelUrl(value), links.LabelLinkError, value));
});

test('validate exact business IDs without coercing unsafe numbers or decoded path payloads', () => {
  for (const id of ['0', '01', '-1', '1e3', '1.0', '9007199254740992', '../7', '%2F7', '%252F7', '%00', '7+1', '%', '7%20']) {
    assert.throws(() => links.parseLabelUrl(`https://youxishen.online/#/pages/label-resolver/index?v=1&kind=finished-product&id=${id}`), links.LabelLinkError, id);
  }
  for (const id of [NaN, Infinity, -1, 0, 1.1, Number.MAX_SAFE_INTEGER + 1]) assert.throws(() => links.buildLabelUrl('finished-product', id), links.LabelLinkError);
  for (const id of [batchId.toLowerCase(), 'BOARD-20261016-A1B2', batchId + '/other', '7']) assert.throws(() => links.buildLabelUrl('paperboard-batch', id), links.LabelLinkError);
  assert.throws(() => links.parseLabelRouteParams({ v: '1', kind: 'finished-product', id: ['7'] }), links.LabelLinkError);
  assert.throws(() => links.parseLabelRouteParams({ v: '1', kind: 'finished-product', id: 7 }), links.LabelLinkError);
});

test('raw page route validation retains duplicate detection through local native shells', () => {
  const url = links.buildLabelUrl('finished-product', 7);
  const flattened = { v: '1', kind: 'finished-product', id: '7' };
  assert.equal(links.parseLabelPageTarget(url, flattened).id, '7');
  assert.equal(links.parseLabelPageTarget(url.replace('https://youxishen.online', 'capacitor://localhost'), flattened).id, '7');
  assert.equal(links.parseLabelPageTarget(url.replace('https://youxishen.online', 'http://127.0.0.1:1234'), flattened).id, '7');
  assert.deepEqual(links.parseLabelPageTarget(undefined, flattened), { version: 1, kind: 'finished-product', id: '7' });
  assert.throws(() => links.parseLabelPageTarget(url + '&id=8', flattened), links.LabelLinkError);
  assert.throws(() => links.parseLabelPageTarget(url.replace('youxishen.online', 'example.com'), flattened), links.LabelLinkError);
});

test('finished DTO is frozen whitelist, all optional fields are disabled by default', () => {
  const dto = domain.buildFinishedLabelSnapshot(product());
  assert.deepEqual(Object.keys(dto).sort(), ['name', 'productId', 'productUrl', 'specification', 'unit']);
  assert.equal(dto.unit, '箱'); assert.equal(Object.isFrozen(dto), true);
  for (const field of ['price', 'phone', 'remark', 'stock', 'image_url']) assert.equal(field in dto, false);
});

test('product keeps specification text and uses real two-dimensional mm fallback only when empty', () => {
  assert.equal(domain.buildFinishedLabelSnapshot(product({ specification: '自定义规格 未声明单位' })).specification, '自定义规格 未声明单位');
  assert.equal(domain.buildFinishedLabelSnapshot(product({ specification: ' ', length: 420.5, width: 260 })).specification, '420.5 × 260 mm');
  for (const value of [undefined, 0, -2, NaN, Infinity, '420']) problem(() => domain.buildFinishedLabelSnapshot(product({ specification: '', length: value })), 'length');
  problem(() => domain.buildFinishedLabelSnapshot(product({ name: '' })), 'name');
  problem(() => domain.buildFinishedLabelSnapshot(product({ deleted_at: 1 })), 'productId');
  problem(() => domain.buildFinishedLabelSnapshot(product({ name: 'x'.repeat(161) })), 'name');
  problem(() => domain.buildFinishedLabelSnapshot(product({ name: 'bad' + String.fromCharCode(0) + 'name' })), 'name');
});

test('stock snapshot preserves zero and business unit; invalid selected fields block', () => {
  const dto = domain.buildFinishedLabelSnapshot(product(), { stockSnapshot: true });
  assert.equal(dto.stockSnapshot, 0); assert.equal(dto.unit, '箱');
  problem(() => domain.buildFinishedLabelSnapshot(product({ unit: '' }), { stockSnapshot: true }), 'unit');
  for (const stock of [NaN, Infinity, -1, '0', undefined]) problem(() => domain.buildFinishedLabelSnapshot(product({ stock }), { stockSnapshot: true }), 'stockSnapshot');
  assert.equal(domain.buildFinishedLabelSnapshot(product({ stock: NaN })).stockSnapshot, undefined);
  assert.equal(domain.buildFinishedLabelSnapshot(product({ unit: '' })).unit, '');
  assert.equal(domain.buildFinishedLabelSnapshot(product({ weight: 0 }), { weight: true }).weight, undefined);
  problem(() => domain.buildFinishedLabelSnapshot(product({ weight: Infinity }), { weight: true }), 'weight');
});

test('selected optional date is explicit, valid and frozen across fresh comparisons', () => {
  const stamp = '2026-10-16T08:30:00.000Z';
  const dto = domain.buildFinishedLabelSnapshot(product(), { printedAt: true, material: true, layers: true }, stamp);
  assert.equal(dto.printedAt, stamp); assert.equal(dto.material, '牛卡'); assert.equal(dto.layers, 5);
  problem(() => domain.buildFinishedLabelSnapshot(product(), { printedAt: true }), 'printedAt');
  problem(() => domain.buildFinishedLabelSnapshot(product(), { printedAt: true }, '2026-02-31T08:30:00.000Z'), 'printedAt');
  assert.equal(domain.snapshotsEqual(dto, domain.buildFinishedLabelSnapshot(product(), { printedAt: true, material: true, layers: true }, stamp)), true);
});

test('paperboard DTO preserves cm and zero quantities with no financial or contact fields', () => {
  const minimal = domain.buildBoardLabelSnapshot(board());
  assert.deepEqual(Object.keys(minimal).sort(), ['batchId', 'batchUrl', 'boardLength', 'boardWidth', 'fluteType', 'supplier']);
  const dto = domain.buildBoardLabelSnapshot(board(), { receivedQty: true, remainingQtySnapshot: true, cartonDimensions: true, receivedDate: true });
  assert.equal(dto.boardLength, 120.5); assert.equal(dto.cartonLength, 42); assert.equal(dto.receivedQty, 0); assert.equal(dto.remainingQtySnapshot, 0); assert.equal(dto.receivedDate, '2026-10-16'); assert.equal(Object.isFrozen(dto), true);
  for (const field of ['unitPrice', 'amount', 'remark', 'movements', 'deliveryNo', 'recipient']) assert.equal(field in dto, false);
  problem(() => domain.buildBoardLabelSnapshot(board({ boardWidth: 0 })), 'boardWidth');
  problem(() => domain.buildBoardLabelSnapshot(board({ remainingQty: 0.5 }), { remainingQtySnapshot: true }), 'remainingQtySnapshot');
  problem(() => domain.buildBoardLabelSnapshot(board({ date: '2026-02-31' }), { receivedDate: true }), 'receivedDate');
  assert.equal(domain.buildBoardLabelSnapshot(board({ faceGsm: 0 }), { faceGsm: true }).faceGsm, undefined);
});

test('snapshot comparison detects visible fields and units, never hidden prices', () => {
  const before = domain.buildFinishedLabelSnapshot(product(), { stockSnapshot: true });
  assert.deepEqual(domain.changedSnapshotFields(before, domain.buildFinishedLabelSnapshot(product({ unit: '个' }), { stockSnapshot: true })), ['unit']);
  assert.deepEqual(domain.changedSnapshotFields(before, domain.buildFinishedLabelSnapshot(product({ stock: 2 }), { stockSnapshot: true })), ['stockSnapshot']);
  assert.equal(domain.snapshotsEqual(before, domain.buildFinishedLabelSnapshot(product({ price: 1 }), { stockSnapshot: true })), true);
  assert.equal(domain.snapshotsEqual(domain.buildFinishedLabelSnapshot(product()), domain.buildFinishedLabelSnapshot(product({ stock: 50 }))), true);
  const batch = domain.buildBoardLabelSnapshot(board(), { remainingQtySnapshot: true });
  assert.deepEqual(domain.changedSnapshotFields(batch, domain.buildBoardLabelSnapshot(board({ remainingQty: 3 }), { remainingQtySnapshot: true })), ['remainingQtySnapshot']);
});

test('resolver movements only contain time/type/quantity/balance, retain zero, reject invalid', () => {
  const item = { id: 'private-id', batchId, createdAt: 1234, date: '2026-10-16', type: 'count', quantity: -2, balance: 0, remark: 'private', recipient: 'private', price: 123 };
  const result = domain.safeBoardMovements([item, { ...item, type: 'unknown' }, { ...item, quantity: NaN }, { ...item, balance: -1 }, { ...item, createdAt: Infinity }, { ...item, type: 'out' }, { ...item, balance: 0.5 }]);
  assert.deepEqual(result, [{ time: 1234, type: 'count', quantity: -2, balance: 0 }]);
  assert.equal(Object.isFrozen(result), true); assert.equal(Object.isFrozen(result[0]), true);
});

test('fresh reads always bypass earlier requests and reject missing/mismatched records', async () => {
  const calls = [];
  const api = load('data', {
    '../../services/api': { getProduct: async (id, options) => { calls.push({ kind: 'product', id, options }); return product(); } },
    '../../services/boards': { getBoard: async (id, options) => { calls.push({ kind: 'board', id, options }); return board(); } }
  });
  await api.fetchLatestLabelRecord('finished-product', '7'); await api.fetchLatestLabelRecord('paperboard-batch', batchId);
  assert.deepEqual(calls, [{ kind: 'product', id: 7, options: { forceNetwork: true } }, { kind: 'board', id: batchId, options: { forceNetwork: true } }]);
  const mismatch = load('data', { '../../services/api': { getProduct: async () => product({ id: 8 }) }, '../../services/boards': { getBoard: async () => null } });
  await assert.rejects(mismatch.fetchLatestLabelRecord('finished-product', '7'), /不存在/);
  await assert.rejects(mismatch.fetchLatestLabelRecord('paperboard-batch', batchId), /不存在/);
});

test('paperboard business label carries saved customer material plate and color only', () => {
 const input = board({customerName:'客户甲', material:'牛卡/高瓦', printPlate:'包装A', printColor:'红黑'});
 const before = JSON.stringify(input);
 const snapshot = domain.buildBoardLabelSnapshot(input, {receivedDate:true, receivedQty:true});
 for (const key of ['customerName','material','printPlate','printColor']) assert.equal(snapshot[key],input[key]);
 assert.equal(snapshot.receivedQty,0);
 assert.equal(snapshot.receivedDate,input.date);
 assert.equal(JSON.stringify(input),before);
 assert.equal(domain.buildBoardLabelSnapshot(board()).customerName,undefined);
 problem(()=>domain.buildBoardLabelSnapshot(board({printColor:'红\u0000黑'})), 'printColor');
 assert.ok(!('amount' in snapshot));
});
