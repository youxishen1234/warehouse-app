const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { execFileSync } = require('node:child_process');
const { empty } = require('./customer-dimensions');

function legacyData(customerIds) {
  return {
    _meta: { schemaVersion: 1, nextProductId: 2, nextCustomerId: customerIds.length + 1, nextTransactionId: 1, nextLedgerId: 1 },
    products: [{
      id: 1, name: 'Legacy carton', category: 'carton', specification: '20x10x5 cm',
      material: 'white', unit: 'piece', stock: 1, price: 0, safety_stock: 0, created_at: 1, updated_at: 1
    }],
    customers: customerIds.map(id => ({ id, name: `Customer ${id}`, debt: 0, created_at: 1, updated_at: 1 })),
    suppliers: [], transactions: [], ledger: [], orders: [], order_events: [], stocktakes: [], print_notes: [],
    delivery_notes: customerIds.map((customerId, index) => ({
      id: index + 1, source_type: 'production', party_type: 'customer',
      customer_id: customerId, customer_name: `Customer ${customerId}`,
      supplier_id: null, supplier_name: '',
      lines: [{
        product_id: 1,
        customer_spec_id: `spec-${customerId}`,
        customer_spec_snapshot: {
          id: `spec-${customerId}`, goods: 'Legacy carton', specification: '20x10x5 cm',
          material: 'white', unit: 'piece', price: 1
        }
      }]
    }))
  };
}

function runStartup(directory, data) {
  const dataFile = path.join(directory, 'data.json');
  const dimensionsFile = path.join(directory, 'dimensions.json');
  fs.writeFileSync(dataFile, JSON.stringify(data));
  fs.writeFileSync(dimensionsFile, JSON.stringify({ ...empty(), revision: 1 }));
  execFileSync(process.execPath, ['-e', "require('./db')"], {
    cwd: __dirname,
    env: {
      ...process.env,
      WAREHOUSE_DATA_FILE: dataFile,
      WAREHOUSE_DIMENSIONS_FILE: dimensionsFile,
      WAREHOUSE_BACKUP_DIR: path.join(directory, 'backups')
    },
    stdio: 'pipe'
  });
  return JSON.parse(fs.readFileSync(dataFile, 'utf8'));
}

test('startup ownership migration only claims products with one consistent customer history', async t => {
  const directories = [];
  t.after(() => {
    for (const directory of directories) fs.rmSync(directory, { recursive: true, force: true });
  });
  const makeDirectory = () => {
    const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'warehouse-owner-migration-'));
    directories.push(directory);
    return directory;
  };

  const consistent = runStartup(makeDirectory(), legacyData([7]));
  assert.equal(consistent._meta.schemaVersion, 2);
  assert.equal(consistent.products[0].customer_id, 7);
  assert.equal(consistent.products[0].customer_name, 'Customer 7');

  const conflicting = runStartup(makeDirectory(), legacyData([7, 8]));
  assert.equal(conflicting._meta.schemaVersion, 2);
  assert.equal(conflicting.products[0].customer_id, undefined);
});
