const assert = require('node:assert/strict');
const fs = require('node:fs');
const test = require('node:test');
const vm = require('node:vm');
const ts = require('typescript');
const compile = file => ts.transpileModule(fs.readFileSync(file, 'utf8'), {
  compilerOptions: { target: ts.ScriptTarget.ES2020, module: ts.ModuleKind.CommonJS }
}).outputText;
const model = {};
vm.runInNewContext(compile('src/pages/home/dashboard-model.ts'), { exports: model, Date });
const now = new Date(2026, 9, 28, 12);
const order = (id, delivery_date, status = '待发货') => ({ id, delivery_date, status, customer_name: `客户${id}` });

test('today tasks cover five groups without including closed orders or inventing payment due dates', () => {
  const data = {
    orders: [order(1, '2026-10-27'), order(2, '2026-10-28'), order(3, '2026-10-31'), order(4, '2026-11-01'), order(5, '2026-10-01', '已完成'), order(6, '2026-10-27', '已取消')],
    products: [{ id: 1, stock: 0, safety_stock: 0 }],
    customers: [{ id: 1, debt: 12.1 }, { id: 2, debt: 0.2 }, { id: 3, debt: 0 }, { id: 4, debt: 99, deleted_at: 1 }],
    suppliers: [{ id: 1, payable: 40 }]
  };
  const rows = model.dashboardTasks(data, now);
  assert.equal(rows.length, 5);
  assert.equal(rows.map(row => row.id).join(','), 'overdue,upcoming,stock,receivable,payable');
  assert.equal(rows[0].count, 1);
  assert.equal(rows[1].count, 2);
  assert.equal(rows[3].amount, 12.3);
  assert.equal(rows[4].amount, 40);
  assert.equal(rows[3].title, '2 位客户待收款');
});

test('delivery attention uses local calendar dates across month boundaries and keeps unscheduled orders out', () => {
  const orders = [order(4, ''), order(3, '2026-11-01'), order(2, '2026-10-31'), order(1, '2026-10-30'), order(5, '2026-11-04')];
  const upcoming = model.attentionOrders(orders, 'upcoming', new Date(2026, 9, 31, 23, 30));
  assert.equal(upcoming.map(row => row.id).join(','), '2,3');
  assert.equal(model.attentionOrders(orders, 'overdue', new Date(2026, 9, 31)).map(row => row.id).join(','), '1');
  assert.equal(model.dashboardTasks({ orders: [], products: [], customers: [], suppliers: [] }, now).length, 0);
});

const deferred = () => {
  let resolve, reject;
  const promise = new Promise((done, fail) => { resolve = done; reject = fail; });
  return { promise, resolve, reject };
};
const flush = () => new Promise(resolve => setImmediate(resolve));
function dataHarness() {
  const slots = [], pending = new Map(), effects = [];
  let cursor = 0, started = false;
  const hook = slot => {
    const index = cursor++;
    if (!(index in slots)) slots[index] = typeof slot === 'function' ? slot() : slot;
    return [slots[index], value => { slots[index] = typeof value === 'function' ? value(slots[index]) : value; }];
  };
  const react = {
    useState: hook,
    useRef: value => hook({ current: value })[0],
    useCallback: fn => { cursor++; return fn; },
    useEffect: fn => { cursor++; if (!started) effects.push(fn); }
  };
  const request = name => () => {
    const result = deferred(), list = pending.get(name) || [];
    list.push(result); pending.set(name, list);
    return result.promise;
  };
  const api = {};
  for (const name of ['getCustomers', 'getSuppliers', 'getProducts', 'getTransactions', 'getLedger', 'getDeliveryNotes', 'getOrders']) api[name] = request(name);
  const exported = {};
  const requireModule = name => {
    if (name === 'react') return react;
    if (name.endsWith('/api')) return api;
    if (name.endsWith('/boards')) return { getBoards: request('getBoards') };
    if (name.endsWith('/business-workflow')) return { getProduction: request('getProduction') };
    if (name.endsWith('/customer-dimensions')) return { getCustomerDimensions: request('getCustomerDimensions') };
    throw new Error(`Unexpected module ${name}`);
  };
  vm.runInNewContext(compile('src/pages/home/useWorkbenchData.ts'), { exports: exported, require: requireModule, Error });
  const render = () => { cursor = 0; return exported.useWorkbenchData(); };
  render(); started = true; effects.forEach(effect => effect());
  return { render, pending };
}

test('a slow or failed activity API does not block independently loaded customers and orders', async () => {
  const harness = dataHarness();
  harness.pending.get('getCustomers')[0].resolve([{ id: 1, name: '已读取客户' }]);
  harness.pending.get('getOrders')[0].resolve([order(1, '2026-10-28')]);
  harness.pending.get('getLedger')[0].reject(new Error('测试弱网'));
  await flush();
  const remote = harness.render();
  assert.equal(remote.data.customers[0].name, '已读取客户');
  assert.equal(remote.data.orders.length, 1);
  assert.equal(remote.sources.production.loading, true, 'an intentionally unresolved production request stays local');
  assert.equal(remote.sources.orders.loading, false);
  assert.match(remote.sources.ledger.error, /账单记录加载失败/);
});

test('a failed refresh retains the last resource snapshot and a stale response cannot replace newer data', async () => {
  const harness = dataHarness();
  harness.pending.get('getProducts')[0].resolve([{ id: 1, name: '第一次成功' }]);
  await flush();
  void harness.render().reload();
  harness.pending.get('getProducts')[1].reject(new Error('刷新失败'));
  await flush();
  assert.equal(harness.render().data.products[0].name, '第一次成功');
  assert.match(harness.render().sources.products.error, /刷新失败/);
  void harness.render().reload();
  void harness.render().reload();
  harness.pending.get('getProducts')[3].resolve([{ id: 1, name: '最新' }]);
  await flush();
  harness.pending.get('getProducts')[2].resolve([{ id: 1, name: '迟到旧结果' }]);
  await flush();
  assert.equal(harness.render().data.products[0].name, '最新');
  assert.equal(harness.render().sources.products.error, '');
});
