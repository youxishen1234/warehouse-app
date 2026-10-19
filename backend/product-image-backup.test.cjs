const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const crypto = require('node:crypto');
const { createStore, imageDirectory, MAX_IMAGE_BYTES } = require('./product-image-backup');

const original = Buffer.concat([Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+jFz8AAAAASUVORK5CYII=', 'base64'), Buffer.from('preserve original camera metadata')]);
const second = Buffer.concat([original, Buffer.from('second image')]);
function fixture(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'warehouse-product-backup-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const source = path.join(root, 'source'), destination = path.join(root, 'destination');
  fs.mkdirSync(source);
  fs.writeFileSync(path.join(source, '1-original.png'), original);
  fs.writeFileSync(path.join(source, '2-other.png'), second);
  const snapshot = { products: [{ id: 1, image_url: '/uploads/products/1-original.png' }, { id: 2, image_url: '/uploads/products/2-other.png' }], ledger: [], ledger_attachment_files: { other: 'retained-ledger-original' } };
  return { root, source, destination, snapshot, store: createStore(source) };
}
test('product image portable backup restores exact original bytes into a new directory', t => {
  const f = fixture(t), before = JSON.stringify(f.snapshot), bundle = f.store.portable(f.snapshot);
  assert.equal(JSON.stringify(f.snapshot), before, 'source snapshot is not mutated');
  assert.equal(bundle.ledger_attachment_files.other, 'retained-ledger-original');
  assert.equal(bundle.product_image_files['1-original.png'].sha256, crypto.createHash('sha256').update(original).digest('hex'));
  assert.equal(bundle.product_image_files['1-original.png'].data, original.toString('base64'));
  const restore = createStore(f.destination);
  assert.equal(restore.validate(bundle), true);
  assert.equal(fs.existsSync(f.destination), false, 'validation never creates files');
  assert.equal(restore.restore(bundle).files, 2);
  assert.deepEqual(fs.readFileSync(path.join(f.destination, '1-original.png')), original);
  assert.deepEqual(fs.readFileSync(path.join(f.destination, '2-other.png')), second);
  assert.equal(restore.restore(bundle).files, 2, 'same bytes are safely reusable');
  assert.deepEqual(fs.readdirSync(f.destination).sort(), ['1-original.png', '2-other.png']);
});
test('portable size ceiling counts existing ledger originals and complete JSON overhead', t => {
  const f = fixture(t), bundle = f.store.portable(f.snapshot), bytes = Buffer.byteLength(JSON.stringify(bundle));
  assert.equal(Buffer.byteLength(JSON.stringify(f.store.portable(f.snapshot, bytes))), bytes);
  assert.throws(() => f.store.portable(f.snapshot, bytes - 1), /备份大小限制/);
  const largeLedger = { ...f.snapshot, ledger_attachment_files: { other: 'x'.repeat(bytes) } };
  assert.throws(() => f.store.portable(largeLedger, bytes), /备份大小限制/);
  assert.throws(() => f.store.portable({ products: [] }, 0), /备份大小限制/);
});
test('missing, oversized and malformed source originals fail instead of producing partial backups', t => {
  const f = fixture(t);
  fs.unlinkSync(path.join(f.source, '2-other.png'));
  assert.throws(() => f.store.portable(f.snapshot), /原件缺失/);
  fs.writeFileSync(path.join(f.source, '2-other.png'), Buffer.from('broken'));
  assert.throws(() => f.store.portable(f.snapshot), /原件损坏/);
  fs.writeFileSync(path.join(f.source, '2-other.png'), Buffer.alloc(MAX_IMAGE_BYTES + 1));
  assert.throws(() => f.store.portable(f.snapshot), /原件无效/);
});
test('manifest validation rejects missing, extra, corrupted or mislabelled files before any writes', t => {
  const f = fixture(t), bundle = f.store.portable(f.snapshot), restore = createStore(f.destination);
  const mutations = [
    x => { delete x.product_image_files['2-other.png']; },
    x => { x.product_image_files['extra.png'] = x.product_image_files['1-original.png']; },
    x => { x.product_image_files['2-other.png'].data = original.toString('base64'); },
    x => { x.product_image_files['2-other.png'].sha256 = '0'.repeat(64); },
    x => { x.product_image_files['2-other.png'].size = 1; },
    x => { x.product_image_files['2-other.png'].mime = 'image/jpeg'; },
    x => { x.product_image_files['2-other.png'].data += '\n'; },
    x => { x.product_image_files['2-other.png'].unknown = true; },
    x => { x.product_image_files = null; },
    x => { x.products[1].image_url = '/uploads/products/../../outside.png'; },
    x => { x.products[1].image_url = 'https://external.invalid/photo.png'; }
  ];
  for (const mutate of mutations) {
    const bad = structuredClone(bundle); mutate(bad);
    assert.throws(() => restore.validate(bad));
    assert.throws(() => restore.restore(bad));
    assert.equal(fs.existsSync(f.destination), false, 'all bundle entries checked before writes');
  }
});
test('conflicting same-name file is preserved and prevents earlier missing files from being written', t => {
  const f = fixture(t), bundle = f.store.portable(f.snapshot);
  fs.mkdirSync(f.destination);
  fs.writeFileSync(path.join(f.destination, '2-other.png'), Buffer.from('unrelated existing file'));
  assert.throws(() => createStore(f.destination).restore(bundle), /现有同名商品图片不同/);
  assert.equal(fs.existsSync(path.join(f.destination, '1-original.png')), false);
  assert.equal(fs.readFileSync(path.join(f.destination, '2-other.png'), 'utf8'), 'unrelated existing file');
});
test('legacy URL-only snapshots remain compatible and new empty manifests are explicit', t => {
  const f = fixture(t), restore = createStore(f.destination);
  assert.equal(restore.validate(f.snapshot), true);
  assert.deepEqual(restore.restore(f.snapshot), { files: 0 });
  assert.equal(fs.existsSync(f.destination), false);
  const empty = f.store.portable({ products: [{ id: 1, image_url: '' }] });
  assert.deepEqual(Object.keys(empty.product_image_files), []);
  assert.equal(restore.validate(empty), true);
});
test('multiple products referencing one filename include one original; JPEG and WebP preserve bytes', t => {
  const f = fixture(t);
  const jpeg = Buffer.from('ffd8ffe0ffd9', 'hex'), webp = Buffer.concat([Buffer.from('RIFF'), Buffer.from([4, 0, 0, 0]), Buffer.from('WEBP')]);
  fs.writeFileSync(path.join(f.source, '3-photo.jpg'), jpeg);
  fs.writeFileSync(path.join(f.source, '4-photo.webp'), webp);
  const snapshot = { products: [{ id: 1, image_url: '/uploads/products/3-photo.jpg' }, { id: 2, image_url: '/uploads/products/3-photo.jpg' }, { id: 3, image_url: '/uploads/products/4-photo.webp' }] };
  const bundle = f.store.portable(snapshot);
  assert.equal(Object.keys(bundle.product_image_files).length, 2);
  createStore(f.destination).restore(bundle);
  assert.deepEqual(fs.readFileSync(path.join(f.destination, '3-photo.jpg')), jpeg);
  assert.deepEqual(fs.readFileSync(path.join(f.destination, '4-photo.webp')), webp);
});
test('configured product image directory is resolved without touching default public assets', t => {
  const f = fixture(t), previous = process.env.WAREHOUSE_PRODUCT_IMAGE_DIR;
  try { process.env.WAREHOUSE_PRODUCT_IMAGE_DIR = f.source; assert.equal(imageDirectory(), path.resolve(f.source)); }
  finally { if (previous === undefined) delete process.env.WAREHOUSE_PRODUCT_IMAGE_DIR; else process.env.WAREHOUSE_PRODUCT_IMAGE_DIR = previous; }
});
test('atomic publication accepts an identical racing writer and never overwrites a conflicting winner', t => {
  const f = fixture(t), bundle = f.store.portable(f.snapshot), realLink = fs.linkSync;
  let collided = false;
  try {
    fs.linkSync = (source, target) => {
      if (!collided) { collided = true; fs.copyFileSync(source, target); throw Object.assign(new Error('exists'), { code: 'EEXIST' }); }
      return realLink(source, target);
    };
    assert.equal(createStore(f.destination).restore(bundle).files, 2);
    assert.deepEqual(fs.readFileSync(path.join(f.destination, '1-original.png')), original);
  } finally { fs.linkSync = realLink; }
  const conflicting = path.join(f.root, 'conflict-race');
  try {
    fs.linkSync = (_source, target) => { fs.writeFileSync(target, 'concurrent winner'); throw Object.assign(new Error('exists'), { code: 'EEXIST' }); };
    assert.throws(() => createStore(conflicting).restore(bundle), /现有同名商品图片不同/);
    assert.deepEqual(fs.readdirSync(conflicting), ['1-original.png'], 'temporary files are cleaned on collision');
    assert.equal(fs.readFileSync(path.join(conflicting, '1-original.png'), 'utf8'), 'concurrent winner');
  } finally { fs.linkSync = realLink; }
});
test('failed publication cleans its temporary file and does not claim restored originals', t => {
  const f = fixture(t), bundle = f.store.portable(f.snapshot), realLink = fs.linkSync;
  try {
    fs.linkSync = () => { throw Object.assign(new Error('disk error'), { code: 'EIO' }); };
    assert.throws(() => createStore(f.destination).restore(bundle), /原件写入失败/);
    assert.deepEqual(fs.readdirSync(f.destination), []);
  } finally { fs.linkSync = realLink; }
});
test('current content-addressed filenames detect changed source bytes and forged bundle associations', t => {
  const f = fixture(t), digest = crypto.createHash('sha256').update(original).digest('hex');
  const name = `7-${digest.slice(0, 24)}.png`;
  fs.writeFileSync(path.join(f.source, name), original);
  const snapshot = { products: [{ id: 7, image_url: `/uploads/products/${name}` }] };
  const bundle = f.store.portable(snapshot);
  fs.writeFileSync(path.join(f.source, name), second);
  assert.throws(() => f.store.portable(snapshot), /原件校验失败/);
  const item = bundle.product_image_files[name];
  Object.assign(item, { data: second.toString('base64'), size: second.length, sha256: crypto.createHash('sha256').update(second).digest('hex') });
  assert.throws(() => createStore(f.destination).restore(bundle), /图片备份校验失败/);
  assert.equal(fs.existsSync(f.destination), false);
});
