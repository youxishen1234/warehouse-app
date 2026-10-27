const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { validateNote } = require('./print-notes');

test('database startup automatically hides duplicate unshipped print notes', () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'warehouse-print-cleanup-'));
  const dataFile = path.join(directory, 'data.json');
  process.env.WAREHOUSE_DATA_FILE = dataFile;
  process.env.WAREHOUSE_BACKUP_DIR = path.join(directory, 'backups');
  const note = validateNote({
    company: 'Cleanup Company', customer_id: null, customer_name: 'Cleanup Customer', address: 'Cleanup Address',
    phone: '123456', receiver: 'Receiver', sender: 'Sender', date: '2026-10-27', paper: '241-93',
    items: [{ product_id: null, name: 'Box', specification: '300x200x100', unit: '个', quantity: 2, price: 3, amount: 6, remark: '' }]
  });
  const stored = (id, createdAt, patch = {}) => ({ ...note, ...patch, id, number: `SH-${id}`, version: 1, created_at: createdAt, updated_at: createdAt });
  fs.writeFileSync(dataFile, JSON.stringify({
    _meta: { schemaVersion: 1 }, products: [], customers: [], suppliers: [], transactions: [], ledger: [],
    print_notes: [stored(2, 200), stored(3, 150, { outbound_at: 300 }), stored(1, 100), stored(4, 200, { receiver: 'Another Receiver' })]
  }));

  try {
    const db = require('./db');
    assert.deepEqual(db.listPrintNotes().map(row => row.id).sort((a, b) => a - b), [1, 3, 4]);
    const persisted = JSON.parse(fs.readFileSync(dataFile, 'utf8'));
    assert.deepEqual(persisted.print_notes.map(row => row.id).sort((a, b) => a - b), [1, 2, 3, 4]);
    assert.equal(persisted.print_notes.find(row => row.id === 2).deleted_at > 0, true);
  } finally {
    fs.rmSync(directory, { recursive: true, force: true });
  }
});
