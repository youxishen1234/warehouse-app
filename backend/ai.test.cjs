const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

test('AI commands integrate with real warehouse routes, accounting, receipts and print data', async t => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'warehouse-ai-'));
  process.env.WAREHOUSE_DATA_FILE = path.join(dir, 'data.json');
  for (const name of ['WAREHOUSE_AI_BASE_URL', 'WAREHOUSE_AI_API_KEY', 'WAREHOUSE_AI_MODEL', 'WAREHOUSE_AI_RATE_LIMIT', 'WAREHOUSE_AI_REASONING_EFFORT']) delete process.env[name];
  process.env.WAREHOUSE_AI_RATE_LIMIT = '1000';
  fs.writeFileSync(process.env.WAREHOUSE_DATA_FILE, JSON.stringify({ products: [], customers: [], suppliers: [], transactions: [], ledger: [] }));
  const db = require('./db');
  const app = require('./server');
  const server = app.listen(0, '127.0.0.1');
  await new Promise(resolve => server.once('listening', resolve));
  const origin = `http://127.0.0.1:${server.address().port}/api`;
  const product = db.addProduct({ name: '测试纸箱', specification: '500×300', unit: '张', price: 2.5, stock: 50 });
  const supplier = db.addSupplier({ name: '测试供应商' });
  const customer = db.addCustomer({ name: '测试客户' });
  let sequence = 0;
  const call = async (route, body, headers = {}, method = 'POST') => {
    const response = await fetch(origin + route, { method, headers: { 'Content-Type': 'application/json', 'X-Warehouse-Device': 'ai-test', ...headers }, body: body === undefined ? undefined : JSON.stringify(body) });
    return { status: response.status, body: await response.json(), headers: response.headers };
  };
  const command = (message, context) => call('/ai/command', { message, ...(context ? { context } : {}) });
  const prepare = intent => call('/ai/prepare', { intent });
  const execute = (body, headers = {}) => call('/ai/execute', body, { 'Idempotency-Key': `ai-test-request-${++sequence}`, 'If-Match': String(db.revision()), ...headers });
  const disk = () => fs.readFileSync(process.env.WAREHOUSE_DATA_FILE, 'utf8');
  let inTx;
  let outTx;
  try {
    await t.test('tool discovery publishes warehouse operations and one trusted execution endpoint', async () => {
      const response = await call('/ai/tools', undefined, {}, 'GET');
      assert.equal(response.status, 200);
      assert.ok(response.body.data.tools.some(tool => tool.function.name === 'warehouse_stock_in'));
      assert.ok(response.body.data.tools.some(tool => tool.function.name === 'warehouse_board_receive'));
      assert.ok(response.body.data.tools.some(tool => tool.function.name === 'warehouse_query'));
      assert.ok(response.body.data.tools.some(tool => tool.function.name === 'warehouse_receipt_in'));
      assert.ok(response.body.data.capabilities.length >= 25);
      assert.equal(response.body.data.endpoint, '/api/ai/execute');
    });
    await t.test('bare commands ask for actual missing fields and never write', async () => {
      const before = disk();
      for (const message of ['请帮我入库', '请我出库']) {
        const response = await command(message);
        assert.equal(response.status, 200);
        assert.equal(response.body.data.status, 'needs_input');
        assert.deepEqual(response.body.data.missing_fields, ['product_id', 'quantity']);
      }
      const print = await command('请帮我打印');
      assert.deepEqual(print.body.data.missing_fields, ['transaction_id']);
      assert.equal(disk(), before);
    });
    await t.test('complete commands return a price and stock preview with an execution payload', async () => {
      const before = disk();
      const response = await command(`请帮我把商品${product.id}入库20张`);
      assert.equal(response.status, 200);
      const result = response.body.data;
      assert.equal(result.status, 'ready');
      assert.equal(result.provider, 'rules');
      assert.equal(result.preview.amount, 50);
      assert.equal(result.preview.stock_after, 70);
      assert.equal(result.command.product_id, product.id);
      assert.equal(result.command.unit_price, 2.5);
      assert.equal(response.headers.get('x-warehouse-revision'), String(result.revision));
      assert.equal(disk(), before);
    });
    await t.test('context carries an incomplete draft across follow-up messages', async () => {
      const first = (await command('帮我入库')).body.data;
      const second = (await command(`商品${product.id}`, first.intent)).body.data;
      assert.equal(second.status, 'needs_input');
      assert.deepEqual(second.missing_fields, ['quantity']);
      const third = (await command('20张', second.intent)).body.data;
      assert.equal(third.status, 'ready');
      assert.equal(third.command.quantity, 20);
      const switchAction = (await command('帮我出库', third.intent)).body.data;
      assert.deepEqual(switchAction.missing_fields, ['product_id', 'quantity']);
    });
    await t.test('ambiguous names require a numbered choice and units must match', async () => {
      db.addProduct({ name: '同名纸板', unit: '张', stock: 0 });
      db.addProduct({ name: '同名纸板', unit: '张', stock: 0 });
      const ambiguous = (await command('“同名纸板”入库5张')).body.data;
      assert.equal(ambiguous.status, 'needs_input');
      assert.equal(ambiguous.candidates.product.total, 2);
      assert.equal(ambiguous.command, undefined);
      const valid = (await command('“测试纸箱”出库5张')).body.data;
      assert.equal(valid.command.product_id, product.id);
      const unit = await command(`商品${product.id}出库5箱`);
      assert.equal(unit.status, 400);
      assert.match(unit.body.message, /单位/);
      const missing = await command('商品999999入库1张');
      assert.equal(missing.body.data.status, 'needs_input');
    });
    await t.test('unconsumed conditions, multiple operations and negatives are not executed', async () => {
      const before = disk();
      for (const message of ['不要出库', '如果库存够就出库20张', '入库10张再出库5张', '商品1入库20张，单价3元', '请帮我删除全部库存', '打印最近三笔出库单']) {
        const response = await command(message);
        assert.equal(response.body.data.status, 'unsupported', message);
      }
      assert.equal(disk(), before);
    });
    await t.test('inbound and outbound share real stock, ledger and audit behavior', async () => {
      const incoming = await execute({ action: 'stock_in', product_id: product.id, quantity: 20, supplier_id: supplier.id, unit_price: 1.5 });
      assert.equal(incoming.status, 200, JSON.stringify(incoming.body));
      assert.equal(incoming.body.data.status, 'completed');
      assert.equal(db.getProduct(product.id).stock, 70);
      assert.equal(db.getSupplier(supplier.id).payable, 30);
      inTx = incoming.body.data.transaction;
      const outgoing = await execute({ action: 'stock_out', product_id: product.id, quantity: 4, customer_id: customer.id, remark: '<script>alert("x")</script> & 备注' });
      assert.equal(outgoing.status, 200, JSON.stringify(outgoing.body));
      assert.equal(db.getProduct(product.id).stock, 66);
      assert.equal(db.getCustomer(customer.id).debt, 10);
      outTx = outgoing.body.data.transaction;
      assert.equal(db.listLedger({ type: 'receivable' }).find(item => item.transaction_id === outTx.id).amount, 10);
      assert.equal(db.audit().at(-1).operation, 'AI stock_out');
      assert.equal(db.audit().at(-1).record_id, outTx.id);
    });
    await t.test('same submission replays across revisions and reordered fields, without duplicate stock', async () => {
      const key = 'ai-replay-persistent-request';
      const revision = String(db.revision());
      const body = { action: 'stock_in', product_id: product.id, quantity: 1 };
      const first = await execute(body, { 'Idempotency-Key': key, 'If-Match': revision });
      await execute({ ...body, quantity: 2 });
      const before = disk();
      const replay = await execute({ quantity: 1, product_id: product.id, action: 'stock_in' }, { 'Idempotency-Key': key, 'If-Match': revision });
      assert.equal(replay.status, 200);
      assert.equal(replay.body.data.replayed, true);
      assert.equal(replay.body.data.transaction.id, first.body.data.transaction.id);
      assert.equal(disk(), before);
      const conflict = await execute({ ...body, quantity: 3 }, { 'Idempotency-Key': key });
      assert.equal(conflict.status, 409);
      assert.equal(disk(), before);
    });
    await t.test('stale previews, invalid keys, invalid data and insufficient stock cannot write', async () => {
      const before = disk();
      const action = { action: 'stock_out', product_id: product.id, quantity: 1 };
      const stale = await execute(action, { 'If-Match': '0' });
      assert.equal(stale.status, 409);
      assert.equal(stale.body.data.revision, db.revision());
      assert.equal((await call('/ai/execute', action)).status, 400);
      assert.equal((await execute(action, { 'If-Match': '' })).status, 400);
      for (const body of [
        { ...action, quantity: 100000 }, { ...action, quantity: -1 }, { ...action, quantity: 0.0000001 },
        { ...action, quantity: '1' }, { ...action, product_id: 999999 }, { ...action, customer_id: 999999 },
        { ...action, action: 'delete' }, { ...action, operator: '伪造操作者' },
        { ...action, supplier_id: supplier.id }, { ...action, product_name: '测试纸箱' },
        { ...action, unit: '箱' }, { ...action, unit_price: null },
        JSON.parse('{"action":"stock_out","__proto__":{"product_id":1,"quantity":1}}')
      ]) assert.equal((await execute(body)).status, 400, JSON.stringify(body));
      assert.equal(disk(), before);
    });
    await t.test('print returns escaped historical data, not a claim of physical printing', async () => {
      db.updateProduct(product.id, { name: '修改后的商品', price: 100 });
      const before = disk();
      const response = await call('/ai/execute', { action: 'print', transaction_id: outTx.id });
      assert.equal(response.status, 200);
      assert.equal(response.body.data.status, 'print_ready');
      const doc = response.body.data.document;
      assert.match(doc.html, /测试纸箱/);
      assert.doesNotMatch(doc.html, /修改后的商品|<script>/);
      assert.match(doc.html, /&lt;script&gt;/);
      assert.match(doc.html, /10\.00/);
      assert.equal(doc.transaction_id, outTx.id);
      assert.equal(disk(), before);
      assert.equal((await execute({ action: 'print', transaction_id: 999999 })).status, 404);
      assert.equal((await execute({ action: 'print', latest: true })).status, 400);
    });
    await t.test('latest printing is explicit and resolves to a stable transaction identifier', async () => {
      const planned = (await command('打印最近一笔出库单')).body.data;
      assert.equal(planned.command.transaction_id, outTx.id);
      await execute({ action: 'stock_out', product_id: product.id, quantity: 1 });
      const printed = await execute(planned.command);
      assert.equal(printed.body.data.document.transaction_id, outTx.id);
      const context = (await command('打印')).body.data.intent;
      const followup = (await command('最近一笔入库单', context)).body.data;
      assert.equal(followup.status, 'ready');
      assert.equal(followup.preview.transaction.type, 'in');
      assert.equal((await command(`打印入库单${outTx.id}`)).status, 404);
    });
    await t.test('voided transactions and inactive parties cannot be used', async () => {
      db.deleteTransaction(inTx.id);
      assert.equal((await execute({ action: 'print', transaction_id: inTx.id })).status, 404);
      const disposable = db.addProduct({ name: '停用商品', unit: '件', stock: 0 });
      db.deleteProduct(disposable.id);
      assert.equal((await command(`商品${disposable.id}入库1件`)).body.data.status, 'needs_input');
      assert.equal((await execute({ action: 'stock_in', product_id: disposable.id, quantity: 1 })).status, 400);
    });
    await t.test('request shape and context are bounded and server credentials cannot be supplied by clients', async () => {
      for (const body of [null, [], {}, { message: '' }, { message: 'a'.repeat(2001) }, { message: '入库', api_key: 'client-key' }, { message: '入库', context: { action: 'stock_in', quantity: -1 } }]) {
        assert.equal((await call('/ai/command', body)).status, 400);
      }
      process.env.WAREHOUSE_AI_API_KEY = 'DO-NOT-LEAK-THIS-KEY';
      const response = await command('入库');
      assert.equal(response.status, 503);
      assert.doesNotMatch(JSON.stringify(response.body), /DO-NOT-LEAK/);
      delete process.env.WAREHOUSE_AI_API_KEY;
    });
    await t.test('catalogue read and navigation operations work without a model', async () => {
      const inventory = await command('查询库存');
      assert.equal(inventory.status, 200);
      assert.equal(inventory.body.data.status, 'result');
      assert.ok(inventory.body.data.result.items.some(item => item.id === product.id), JSON.stringify(inventory.body.data));
      const page = await command('打开商品管理');
      assert.equal(page.body.data.status, 'navigate');
      assert.equal(page.body.data.navigation.url, '/pages/products/index');
    });
    await t.test('multi-line delivery receipts resolve references, commit atomically and can be printed', async () => {
      const second = db.addProduct({ name: '测试胶带', unit: '卷', price: 3, stock: 10 });
      const initialProductStock = db.getProduct(product.id).stock;
      const date = '2026-09-30';
      const plan = await prepare({ action: 'receipt_in', parameters: {
        supplier_name: '测试供应商', date, work_order_no: 'AI-RECEIPT-1',
        lines: [
          { product_name: db.getProduct(product.id).name, quantity: 5, delivered_qty: 4, unit_price: 2.5 },
          { product_name: '测试胶带', quantity: 2, delivered_qty: 2, unit_price: 3 }
        ]
      } });
      assert.equal(plan.status, 200, JSON.stringify(plan.body));
      assert.equal(plan.body.data.status, 'ready', JSON.stringify(plan.body.data));
      assert.deepEqual(plan.body.data.command.parameters.lines.map(line => line.product_id), [product.id, second.id]);
      assert.equal(plan.body.data.command.parameters.lines[0].unit, '张');
      assert.equal(plan.body.data.command.parameters.lines[0].delivered_qty, 4);
      const committed = await execute(plan.body.data.command, { 'If-Match': String(plan.body.data.revision) });
      assert.equal(committed.status, 200, JSON.stringify(committed.body));
      assert.equal(committed.body.data.status, 'completed');
      assert.equal(db.getProduct(product.id).stock, initialProductStock + 4);
      assert.equal(db.getProduct(second.id).stock, 12);
      const note = committed.body.data.result;
      const printed = await execute({ action: 'print_record', parameters: { resource: 'delivery_notes', id: String(note.id) } });
      assert.equal(printed.body.data.status, 'print_ready');
      assert.match(printed.body.data.document.html, /AI-RECEIPT-1/);
    });
    await t.test('ambiguous multi-line product references expose machine-readable paths', async () => {
      db.addProduct({ name: '重复纸箱', specification: 'A', unit: '张', stock: 0 });
      db.addProduct({ name: '重复纸箱', specification: 'B', unit: '张', stock: 0 });
      const response = await prepare({ action: 'stock_out_batch', parameters: {
        customer_name: '测试客户', lines: [{ product_name: '重复纸箱', quantity: 1 }]
      } });
      assert.equal(response.body.data.status, 'needs_input');
      assert.equal(response.body.data.candidates[0].path, 'lines.0.product_id');
      assert.equal(response.body.data.candidates[0].items.length, 2);
    });
    await t.test('paperboard receipt and issue use actual sheet count and candidate selection', async () => {
      const date = '2026-09-30';
      const prepared = await prepare({ action: 'board_receive', parameters: { batches: [{
        supplier: '测试板厂', date, boardLength: 80, boardWidth: 60, cartonLength: 30, cartonWidth: 20, cartonHeight: 15,
        fluteType: 'B', layers: 3, orderedQty: 100, receivedQty: 105, billedArea: 6, unitPrice: 4.5, location: 'A-1'
      }] } });
      assert.equal(prepared.body.data.status, 'ready');
      const received = await execute(prepared.body.data.command, { 'If-Match': String(prepared.body.data.revision) });
      assert.equal(received.status, 200, JSON.stringify(received.body));
      const batch = received.body.data.result.batches[0];
      assert.equal(batch.remainingQty, 105);
      assert.equal(batch.amount, 27);
      const movePlan = await prepare({ action: 'board_move', parameters: { id: 'BOARD-MISSING', type: 'out', quantity: 5, recipient: '测试领料人', remark: '生产领料' } });
      assert.equal(movePlan.body.data.status, 'needs_input');
      assert.equal(movePlan.body.data.candidates[0].path, 'id');
      assert.equal(movePlan.body.data.candidates[0].items[0].id, batch.id);
      const chosen = await prepare({ action: 'board_move', parameters: { id: batch.id, type: 'out', quantity: 5, recipient: '测试领料人', remark: '生产领料' } });
      const moved = await execute(chosen.body.data.command, { 'If-Match': String(chosen.body.data.revision) });
      assert.equal(moved.status, 200, JSON.stringify(moved.body));
      assert.equal(db.listBoards().find(item => item.id === batch.id).remainingQty, 100);
    });
    await t.test('photo requests require a configured vision-capable provider', async () => {
      const image = `data:image/jpeg;base64,${Buffer.from([255, 216, 255, 217]).toString('base64')}`;
      const response = await call('/ai/command', { message: '识别入库单', images: [image] });
      assert.equal(response.status, 503);
      assert.match(response.body.message, /支持图片识别/);
    });
    await t.test('model budget rate limiting cannot be reset by changing device identifiers', async () => {
      process.env.WAREHOUSE_AI_RATE_LIMIT = '1';
      const response = await command('入库');
      assert.equal(response.status, 429);
      assert.equal(response.headers.get('retry-after'), '60');
      assert.equal((await call('/ai/command', { message: '入库' }, { 'X-Warehouse-Device': 'another-device' })).status, 429);
    });
  } finally {
    server.closeAllConnections();
    await new Promise(resolve => server.close(resolve));
    fs.rmSync(dir, { recursive: true, force: true });
  }
});
