const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { empty } = require('./customer-dimensions');
const productionPricing = require('./production-pricing');

test('customer carton account and dimension-book specs resolve atomically into production receipt products', async t => {
  const temporary = fs.mkdtempSync(path.join(os.tmpdir(), 'warehouse-customer-spec-inbound-'));
  const dataFile = path.join(temporary, 'data.json');
  const dimensionsFile = path.join(temporary, 'dimensions.json');
  process.env.WAREHOUSE_DATA_FILE = dataFile;
  process.env.WAREHOUSE_BACKUP_DIR = path.join(temporary, 'backups');
  process.env.WAREHOUSE_DIMENSIONS_FILE = dimensionsFile;
  fs.writeFileSync(dataFile, JSON.stringify({ products: [], customers: [], suppliers: [], transactions: [], ledger: [] }));
  const legacy = { ...empty(), customers: [
    { id: 'legacy-a', name: ' legacy　buyer ', specs: [
      { id: 'blank-goods', goods: '', size: '30×20×10', sizeUnit: 'cm', material: '牛皮纸', unit: '个', kind: '成品' },
      { id: 'named-40', goods: '多尺寸纸箱', size: '40×30×20', sizeUnit: 'cm', material: '牛皮纸', unit: '个', kind: '成品' },
      { id: 'board', goods: '纸板项', size: '40×30×20', sizeUnit: 'cm', material: '牛皮纸', unit: '张', kind: '纸板' }
    ] },
    { id: 'legacy-b', name: 'LEGACY BUYER', specs: [
      { id: 'duplicate-40', goods: '多尺寸纸箱', size: '40×30×20', sizeUnit: 'cm', material: '牛皮纸', unit: '个', kind: '成品' },
      { id: 'named-50', goods: '多尺寸纸箱', size: '50×40×30', sizeUnit: 'cm', material: '牛皮纸', unit: '个', kind: '成品' }
    ] }
  ] };
  fs.writeFileSync(dimensionsFile, JSON.stringify(legacy));
  const db = require('./db');
  let sequence = 0;
  const receipt = (customer, specId, price, extra = {}) => db.addDeliveryNote({
    source_type: 'production', customer_id: customer.id, party_type: 'customer',
    work_order_no: `SPEC-IN-${++sequence}`,
    lines: [{ product_id: null, customer_spec_id: specId, create_product: true, quantity: 5, delivered_qty: 4, unit_price: price, ...extra }]
  });
  const disk = () => fs.readFileSync(dataFile, 'utf8');
  try {
    const customer = db.addCustomer({ name: 'Legacy Buyer', specs: [
      { id: 'account-priced', goods: '账户纸箱', specification: '20×15×10 cm', material: '白卡纸', unit: '个', price: 7 }
    ] });

    await t.test('merges account specs and normalized same-name dimension records while filtering and deduplicating', () => {
      const account = db.listCartonInboundCustomers().find(row => row.id === customer.id);
      assert.ok(account);
      assert.deepEqual(account.specs.map(spec => spec.id), [
        'account-priced',
        'dimension:["legacy-a","blank-goods"]',
        'dimension:["legacy-a","named-40"]',
        'dimension:["legacy-b","named-50"]'
      ]);
      assert.equal(account.specs[1].goods, '', 'missing goods remain editable instead of receiving an invented name');
      assert.equal(account.specs[1].unit, '个');
      assert.equal(account.specs[1].price, null);
      assert.equal(account.specs.filter(spec => spec.goods === '多尺寸纸箱').length, 2, 'same goods with distinct dimensions remain selectable');

      const duplicate = db.addCustomer({ name: ' LEGACY BUYER ' });
      assert.deepEqual(db.listCartonInboundCustomers().find(row => row.id === duplicate.id).specs, [], 'ambiguous warehouse account names suppress legacy joins');
      assert.equal(db.listCartonInboundCustomers().find(row => row.id === customer.id).specs.length, 1);
      db.deleteCustomer(duplicate.id);
    });

    await t.test('priced account specs create stock-only zero-base-price SKUs and reject stale quotes', () => {
      const spec = db.listCartonInboundCustomers().find(row => row.id === customer.id).specs.find(row => row.id === 'account-priced');
      const note = receipt(customer, spec.id, 7);
      const product = db.getProduct(note.lines[0].product_id);
      assert.equal(product.name, '账户纸箱');
      assert.equal(product.category, '纸箱');
      assert.equal(product.price, 0);
      assert.equal(product.customer_id, customer.id);
      assert.equal(product.stock, 4);
      assert.equal(product.length, 200);
      assert.equal(product.width, 150);
      assert.equal(note.lines[0].square_meters, 0.12, 'physical cm dimensions are converted to mm for area');
      assert.equal(note.total_amount, 28);
      assert.equal(note.lines[0].customer_spec_snapshot.price, 7);
      assert.equal(db.getCustomer(customer.id).debt, 28);

      db.updateCustomer(customer.id, { specs: [{ ...spec, price: 8 }] });
      const before = disk();
      assert.throws(() => receipt(customer, spec.id, 7), /单价.*更新|刷新/);
      assert.equal(disk(), before);
    });

    await t.test('identical specifications from different customers never share stock SKUs', () => {
      const twin = db.addCustomer({ name: 'Twin Buyer', specs: [{
        id: 'twin-account-priced', goods: '账户纸箱', specification: '20×15×10 cm',
        material: '白卡纸', unit: '个', price: 9
      }] });
      const twinSpec = db.listCartonInboundCustomers().find(row => row.id === twin.id).specs[0];
      const twinNote = receipt(twin, twinSpec.id, 9);
      const unrelatedNote = db.listDeliveryNotes().find(note => note.customer_id === customer.id && note.lines[0].product_name === '账户纸箱');
      assert.ok(unrelatedNote);
      assert.notEqual(twinNote.lines[0].product_id, unrelatedNote.lines[0].product_id);
      const twinProduct = db.getProduct(twinNote.lines[0].product_id);
      assert.equal(twinProduct.customer_id, twin.id);
      assert.equal(twinProduct.customer_name, twin.name);
      assert.equal(twinNote.total_amount, 36);
      assert.equal(db.getCustomer(twin.id).debt, 36);
    });

    await t.test('customer-spec dimensions are authoritative for area even when stored product length is corrupt', () => {
      const owner = db.addCustomer({ name: 'Dimension Owner', specs: [{
        id: 'dimension-owner-spec', goods: '尺寸异常纸箱', specification: '10×8×6 cm',
        material: '白卡纸', unit: '个', price: 1.2
      }] });
      const stored = db.addProduct({
        name: '尺寸异常纸箱', category: '纸箱', specification: '10×8×6 cm',
        material: '白卡纸', unit: '个', price: 0, stock: 0, length: 999, width: 777
      });
      stored.customer_id = owner.id;
      stored.customer_name = owner.name;
      const spec = db.listCartonInboundCustomers().find(row => row.id === owner.id).specs[0];
      const note = receipt(owner, spec.id, 1.2, { product_id: stored.id });
      assert.equal(note.lines[0].product_id, stored.id);
      assert.equal(note.lines[0].square_meters, 0.032, '4 × 10cm × 8cm, not stored 999×777mm');
      assert.equal(note.total_amount, 4.8);
    });

    await t.test('unpriced legacy specs require manual price and support separate SKUs for one goods name', () => {
      const specs = db.listCartonInboundCustomers().find(row => row.id === customer.id).specs;
      const unpriced = specs.find(row => row.id === 'dimension:["legacy-a","blank-goods"]');
      const before = disk();
      assert.throws(() => receipt(customer, unpriced.id, undefined, { goods: '纸箱规格' }), /填写入库单价/);
      assert.equal(disk(), before, 'failed manual-price validation rolls back its newly-created SKU');

      const blankNote = receipt(customer, unpriced.id, 2.5, { goods: '纸箱规格' });
      const blankProduct = db.getProduct(blankNote.lines[0].product_id);
      assert.equal(blankProduct.name, '纸箱规格');
      assert.equal(blankProduct.unit, '个');
      assert.equal(blankNote.lines[0].customer_spec_snapshot.price, 2.5);
      assert.equal(blankNote.total_amount, 10);

      const sized = specs.filter(row => row.goods === '多尺寸纸箱');
      const first = receipt(customer, sized[0].id, 1);
      const second = receipt(customer, sized[1].id, 2);
      assert.notEqual(first.lines[0].product_id, second.lines[0].product_id);
      assert.equal(db.getProduct(first.lines[0].product_id).length, 400);
      assert.equal(db.getProduct(second.lines[0].product_id).length, 500);
      assert.equal(db.getProduct(first.lines[0].product_id).material, '牛皮纸');
    });

    await t.test('mismatched explicit products are rejected; duplicate products and later-line failures roll back', () => {
      const spec = db.listCartonInboundCustomers().find(row => row.id === customer.id).specs.find(row => row.id === 'dimension:["legacy-a","named-40"]');
      const mismatch = db.addProduct({ name: spec.goods, category: '纸箱', specification: '40×30×20 cm', material: '瓦楞纸', unit: '个', price: 9, stock: 0 });
      const beforeMismatch = disk();
      assert.throws(() => receipt(customer, spec.id, 1, { product_id: mismatch.id }), /商品.*规格.*不匹配/);
      assert.equal(disk(), beforeMismatch);
      assert.equal(db.getProduct(mismatch.id).customer_id, undefined);

      const beforeDuplicate = disk();
      assert.throws(() => db.addDeliveryNote({
        source_type: 'production', customer_id: customer.id, party_type: 'customer', work_order_no: `SPEC-IN-${++sequence}`,
        lines: [
          { product_id: null, customer_spec_id: spec.id, quantity: 1, delivered_qty: 1, unit_price: 1 },
          { product_id: null, customer_spec_id: spec.id, quantity: 1, delivered_qty: 1, unit_price: 1 }
        ]
      }), /同一商品不能重复/);
      assert.equal(disk(), beforeDuplicate);

      const accountSpec = db.listCartonInboundCustomers().find(row => row.id === customer.id).specs[0];
      const beforeLaterFailure = disk();
      assert.throws(() => db.addDeliveryNote({
        source_type: 'production', customer_id: customer.id, party_type: 'customer', work_order_no: `SPEC-IN-${++sequence}`,
        lines: [
          { product_id: null, customer_spec_id: accountSpec.id, quantity: 1, delivered_qty: 1, unit_price: 8 },
          { product_id: 987654321, quantity: 1, delivered_qty: 1, unit_price: 1 }
        ]
      }), /有效商品/);
      assert.equal(disk(), beforeLaterFailure, 'all earlier implicit product creation and inbound updates roll back');
    });

    await t.test('customer spec validation accepts nullable price but rejects duplicates and invalid prices', () => {
      const add = specs => db.addCustomer({ name: `Validation ${++sequence}`, specs });
      assert.doesNotThrow(() => add([{ id: 'free', goods: 'Free carton', specification: '1×2×3 cm', price: null }]));
      assert.throws(() => add([
        { id: 'dup', goods: 'A', specification: '1×2×3 cm', price: 1 },
        { id: 'dup', goods: 'B', specification: '1×2×3 cm', price: 1 }
      ]), /编号重复/);
      assert.throws(() => add([{ id: 'bad-price', goods: 'A', specification: '1×2×3 cm', price: Infinity }]), /单价无效/);
      assert.doesNotThrow(() => add([{ id: 'partial-spec', goods: 'A', specification: ' ', price: 1 }]));
      assert.throws(() => add([{ id: 'empty-spec', goods: ' ', specification: ' ', price: null }]), /不能保存完全空白/);
      const merged = productionPricing.mergeCustomerCartonSpecifications(
        { id: 1, name: 'Blank Unit Buyer' }, [{ id: 1, name: 'Blank Unit Buyer' }],
        { customers: [{ id: 'legacy-unit', name: 'blank unit buyer', specs: [
          { id: 'blank-unit-spec', goods: '箱体', size: '10×8×5', sizeUnit: 'cm', unit: '', material: '', kind: '成品' }
        ] }] }
      );
      assert.equal(merged[0].unit, '', 'missing units are not replaced with a fabricated default');
    });
  } finally {
    assert.ok(path.resolve(temporary).startsWith(path.resolve(os.tmpdir()) + path.sep));
    fs.rmSync(temporary, { recursive: true, force: true });
  }
});
