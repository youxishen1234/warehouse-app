const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { execFileSync } = require('node:child_process');

test('image URLs remain relative and portable across backup restore directories', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'warehouse-image-backup-'));
  const source = path.join(root, 'source.json');
  const target = path.join(root, 'target.json');
  const script = `
    const db = require('./db');
    const product = db.addProduct({ name: '图片商品', stock: 0, price: 2 });
    db.updateProduct(product.id, { image_url: require('node:path').join(require('node:os').tmpdir(), 'uploads', 'products', product.id + '-abc123.png') });
    const backup = db.backupData();
    if (backup.products[0].image_url !== '/uploads/products/1-abc123.png') process.exit(2);
    if (backup.products[0].image_url.includes(require('node:path').resolve('.'))) process.exit(3);
    require('node:fs').writeFileSync(process.env.BACKUP_OUTPUT, JSON.stringify(backup));
  `;
  try {
    fs.writeFileSync(source, JSON.stringify({ products: [], customers: [], suppliers: [], transactions: [], orders: [], ledger: [], order_events: [], stocktakes: [], delivery_notes: [], _meta: { nextProductId: 1, nextCustomerId: 1, nextSupplierId: 1, nextTransactionId: 1, nextLedgerId: 1, nextOrderId: 1, nextOrderEventId: 1, nextStocktakeId: 1, nextDeliveryNoteId: 1 } }));
    execFileSync(process.execPath, ['-e', script], { cwd: path.join(__dirname), env: { ...process.env, WAREHOUSE_DATA_FILE: source, BACKUP_OUTPUT: target }, stdio: 'pipe' });
    const restored = JSON.parse(fs.readFileSync(target, 'utf8'));
    assert.match(restored.products[0].image_url, /^\/uploads\/products\/[A-Za-z0-9._-]+$/);
    assert.equal(restored.products[0].image_url.includes(root), false);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});
