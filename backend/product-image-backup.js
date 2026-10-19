const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');

const MAX_IMAGE_BYTES = 2 * 1024 * 1024;
const sha256 = bytes => crypto.createHash('sha256').update(bytes).digest('hex');
const invalid = message => Object.assign(new Error(message), { status: 400 });
const storageError = message => Object.assign(new Error(message), { status: 500 });
const imageDirectory = () => path.resolve(process.env.WAREHOUSE_PRODUCT_IMAGE_DIR || path.join(__dirname, 'public', 'uploads', 'products'));
const mimeForName = name => /\.png$/i.test(name) ? 'image/png' : /\.jpe?g$/i.test(name) ? 'image/jpeg' : /\.webp$/i.test(name) ? 'image/webp' : null;
const matchesContentName = (name, digest) => {
  const currentName = /^[1-9][0-9]*-([a-f0-9]{24})\.(?:png|jpg|webp)$/.exec(name);
  return !currentName || currentName[1] === digest.slice(0, 24);
};
// Match the existing product-upload contract. Backup must preserve accepted
// original bytes, including camera metadata, rather than re-encode the image.
function validImageBytes(mime, bytes) {
  if (mime === 'image/png') return bytes.length >= 8 && bytes.subarray(0, 8).equals(Buffer.from('89504e470d0a1a0a', 'hex'));
  if (mime === 'image/jpeg') return bytes.length >= 3 && bytes[0] === 255 && bytes[1] === 216 && bytes[2] === 255;
  if (mime === 'image/webp') return bytes.length >= 12 && bytes.toString('ascii', 0, 4) === 'RIFF' && bytes.toString('ascii', 8, 12) === 'WEBP';
  return false;
}
function references(snapshot) {
  if (!snapshot || typeof snapshot !== 'object' || !Array.isArray(snapshot.products)) throw invalid('备份商品表无效');
  const names = new Set();
  for (const product of snapshot.products) {
    const url = product?.image_url;
    if (url === undefined || url === null || url === '') continue;
    const match = typeof url === 'string' && /^\/uploads\/products\/([A-Za-z0-9._-]{1,255})$/.exec(url);
    if (!match || !mimeForName(match[1])) throw invalid('商品图片路径无效');
    names.add(match[1]);
  }
  return names;
}
function decodeBundle(snapshot) {
  // Older exports held only URLs. Preserve their existing restore behavior.
  if (snapshot?.product_image_files === undefined) return null;
  const expected = references(snapshot), files = snapshot.product_image_files;
  if (!files || typeof files !== 'object' || Array.isArray(files)) throw invalid('商品图片备份格式无效');
  if (Object.keys(files).length !== expected.size || Object.keys(files).some(name => !expected.has(name))) throw invalid('备份商品图片缺失或未关联');
  const decoded = new Map();
  for (const name of expected) {
    if (!Object.prototype.hasOwnProperty.call(files, name)) throw invalid('备份缺少商品图片原件');
    const item = files[name];
    if (!item || typeof item !== 'object' || Array.isArray(item)
      || Object.keys(item).some(key => !['mime', 'size', 'sha256', 'data'].includes(key))
      || item.mime !== mimeForName(name) || !Number.isSafeInteger(item.size) || item.size <= 0 || item.size > MAX_IMAGE_BYTES
      || !/^[a-f0-9]{64}$/.test(item.sha256 || '') || typeof item.data !== 'string'
      || item.data.length !== 4 * Math.ceil(item.size / 3) || !/^[A-Za-z0-9+/]+={0,2}$/.test(item.data)) throw invalid('商品图片备份索引无效');
    const bytes = Buffer.from(item.data, 'base64');
    if (bytes.length !== item.size || bytes.toString('base64') !== item.data || sha256(bytes) !== item.sha256 || !matchesContentName(name, item.sha256) || !validImageBytes(item.mime, bytes)) throw invalid('商品图片备份校验失败');
    decoded.set(name, { bytes, sha256: item.sha256 });
  }
  return decoded;
}
function createStore(directory = imageDirectory()) {
  const root = path.resolve(directory);
  const targetPath = name => {
    const target = path.resolve(root, name);
    if (!target.startsWith(root + path.sep)) throw invalid('商品图片路径无效');
    return target;
  };
  function portable(snapshot, maxBytes = Infinity) {
    if (typeof maxBytes !== 'number' || Number.isNaN(maxBytes) || maxBytes < 0) throw invalid('备份容量限制无效');
    const names = references(snapshot), files = Object.create(null);
    const result = { ...snapshot, product_image_files: files };
    // Count the entire portable snapshot, including ledger_attachment_files.
    let estimatedBytes = Buffer.byteLength(JSON.stringify(result));
    if (estimatedBytes > maxBytes) throw invalid('含图片的备份超过服务器备份大小限制');
    let count = 0;
    for (const name of names) {
      const target = targetPath(name), mime = mimeForName(name);
      let stat;
      try { stat = fs.lstatSync(target); } catch { throw storageError('商品图片原件缺失，已中止备份'); }
      if (!stat.isFile() || stat.size <= 0 || stat.size > MAX_IMAGE_BYTES) throw storageError('商品图片原件无效，已中止备份');
      const shell = { mime, size: stat.size, sha256: '0'.repeat(64), data: '' };
      estimatedBytes += Buffer.byteLength(JSON.stringify(name)) + 1 + Buffer.byteLength(JSON.stringify(shell)) + 4 * Math.ceil(stat.size / 3) + (count++ ? 1 : 0);
      if (estimatedBytes > maxBytes) throw invalid('含图片的备份超过服务器备份大小限制');
      let bytes;
      try { bytes = fs.readFileSync(target); } catch { throw storageError('商品图片原件无法读取，已中止备份'); }
      if (bytes.length !== stat.size || !validImageBytes(mime, bytes)) throw storageError('商品图片原件损坏，已中止备份');
      const digest = sha256(bytes);
      if (!matchesContentName(name, digest)) throw storageError('商品图片原件校验失败，已中止备份');
      files[name] = { mime, size: bytes.length, sha256: digest, data: bytes.toString('base64') };
    }
    if (Buffer.byteLength(JSON.stringify(result)) > maxBytes) throw invalid('含图片的备份超过服务器备份大小限制');
    return result;
  }
  function validate(snapshot) { decodeBundle(snapshot); return true; }
  function identicalExisting(target, item) {
    let stat;
    try { stat = fs.lstatSync(target); } catch (error) { if (error.code === 'ENOENT') return false; throw storageError('无法检查现有商品图片'); }
    if (!stat.isFile() || stat.size !== item.bytes.length) throw Object.assign(new Error('现有同名商品图片不同，已中止恢复'), { status: 409 });
    let bytes;
    try { bytes = fs.readFileSync(target); } catch { throw storageError('无法读取现有商品图片'); }
    if (sha256(bytes) !== item.sha256) throw Object.assign(new Error('现有同名商品图片不同，已中止恢复'), { status: 409 });
    return true;
  }
  function restore(snapshot) {
    const decoded = decodeBundle(snapshot);
    if (!decoded || !decoded.size) return { files: 0 };
    // Validate every original and every existing destination before creating
    // files. A later I/O failure may leave immutable, unreferenced images only.
    const missing = [];
    for (const [name, item] of decoded) { const target = targetPath(name); if (!identicalExisting(target, item)) missing.push({ target, item }); }
    try { fs.mkdirSync(root, { recursive: true }); } catch { throw storageError('无法创建商品图片恢复目录'); }
    for (const { target, item } of missing) {
      const temp = `${target}.restore-${process.pid}-${crypto.randomBytes(8).toString('hex')}.tmp`;
      try {
        const fd = fs.openSync(temp, 'wx', 0o644);
        try { fs.writeFileSync(fd, item.bytes); fs.fsyncSync(fd); } finally { fs.closeSync(fd); }
        try { fs.linkSync(temp, target); }
        catch (error) {
          if (error.code !== 'EEXIST') throw error;
          if (!identicalExisting(target, item)) throw storageError('商品图片恢复目标已变化，请重试');
        }
        try { const fd = fs.openSync(root, 'r'); try { fs.fsyncSync(fd); } finally { fs.closeSync(fd); } } catch { /* Windows cannot fsync directories. */ }
      } catch (error) { if (error.status) throw error; throw storageError('商品图片原件写入失败，已中止恢复'); }
      finally { try { fs.unlinkSync(temp); } catch (error) { if (error.code !== 'ENOENT') { /* A private temporary original may remain; never unlink published files. */ } } }
    }
    return { files: decoded.size };
  }
  return { portable, validate, restore };
}
module.exports = { createStore, imageDirectory, MAX_IMAGE_BYTES, validImageBytes };
