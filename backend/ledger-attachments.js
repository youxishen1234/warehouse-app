const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');

const MAX_IMAGE_BYTES = 12 * 1024 * 1024;
const JSON_LIMIT = 17 * 1024 * 1024;
const MAX_ATTACHMENTS = 20;
const KINDS = ['delivery', 'signed', 'payment'];
const hash = bytes => crypto.createHash('sha256').update(bytes).digest('hex');
const invalid = message => Object.assign(new Error(message), { status: 400 });
const validMime = (mime, bytes) => {
  if (mime === 'image/png') return bytes.length >= 8 && bytes.subarray(0, 8).equals(Buffer.from('89504e470d0a1a0a', 'hex'));
  if (mime === 'image/jpeg') return bytes.length >= 3 && bytes[0] === 255 && bytes[1] === 216 && bytes[2] === 255;
  if (mime === 'image/webp') return bytes.length >= 12 && bytes.toString('ascii', 0, 4) === 'RIFF' && bytes.toString('ascii', 8, 12) === 'WEBP';
  return false;
};
// 仅校验文件头会放过“只有 PNG 头的损坏文件”，这里补充结构完整性检查。
function structurallyValid(mime, bytes) {
  if (mime === 'image/png') {
    // 按块遍历：必须包含 IHDR、至少一个 IDAT 且 IDAT 可解压、以 IEND 结束。
    // IEND 之后的附加字节（相机元数据等）不影响图片有效性，允许保留。
    if (bytes.length < 8 + 25 + 12) return false;
    if (bytes.toString('ascii', 12, 16) !== 'IHDR') return false;
    try {
      let offset = 8; const inflate = require('node:zlib').inflateSync; const chunks = []; let sawIEND = false;
      while (offset + 12 <= bytes.length) {
        const length = bytes.readUInt32BE(offset);
        if (!Number.isFinite(length) || length < 0 || offset + 12 + length > bytes.length) return false;
        const type = bytes.toString('ascii', offset + 4, offset + 8);
        if (type === 'IDAT') chunks.push(bytes.subarray(offset + 8, offset + 8 + length));
        if (type === 'IEND') { sawIEND = true; break; }
        offset += 12 + length;
      }
      if (!sawIEND || !chunks.length) return false;
      inflate(Buffer.concat(chunks));
      return true;
    } catch (error) { return false; }
  }
  if (mime === 'image/jpeg') return bytes.length >= 4 && bytes[bytes.length - 2] === 0xFF && bytes[bytes.length - 1] === 0xD9;
  if (mime === 'image/webp') { const size = bytes.readUInt32LE(4); return 8 + size >= bytes.length - 1 && 8 + size <= bytes.length + 8; }
  return false;
}

function decode(raw) {
  if (typeof raw !== 'string' || raw.length > Math.ceil(MAX_IMAGE_BYTES / 3) * 4 + 40) throw invalid('每张照片不能超过 12 MB');
  const match = /^data:(image\/(?:jpeg|png|webp));base64,([A-Za-z0-9+/]+={0,2})$/.exec(raw);
  if (!match) throw invalid('请选择 JPG、PNG 或 WebP 照片');
  const bytes = Buffer.from(match[2], 'base64');
  if (bytes.length === 0 || bytes.length > MAX_IMAGE_BYTES) throw invalid('每张照片不能超过 12 MB');
  if (bytes.toString('base64') !== match[2] || !validMime(match[1], bytes) || !structurallyValid(match[1], bytes)) throw invalid('照片文件损坏或内容与格式不一致，请重新选择');
  return { bytes, mime: match[1], sha256: hash(bytes) };
}

function createStore(databasePath) {
  // Never place evidence under the public web root. Files are immutable and
  // addressed by checksum internally; HTTP access uses a random attachment ID.
  const directory = `${path.resolve(databasePath)}.attachments`;
  function filePath(sha256) {
    if (!/^[a-f0-9]{64}$/.test(sha256 || '')) throw invalid('凭证校验值无效');
    return path.join(directory, sha256);
  }
  function write(bytes, sha256) {
    fs.mkdirSync(directory, { recursive: true, mode: 0o700 });
    const target = filePath(sha256);
    if (fs.existsSync(target)) {
      if (hash(fs.readFileSync(target)) !== sha256) throw new Error('凭证文件校验失败');
      return;
    }
    const temp = `${target}.${crypto.randomUUID()}.tmp`;
    try {
      const fd = fs.openSync(temp, 'wx', 0o600);
      try { fs.writeFileSync(fd, bytes); fs.fsyncSync(fd); } finally { fs.closeSync(fd); }
      fs.renameSync(temp, target);
      try { const fd = fs.openSync(directory, 'r'); try { fs.fsyncSync(fd); } finally { fs.closeSync(fd); } } catch { /* Windows does not fsync directories. */ }
    } finally { if (fs.existsSync(temp)) fs.unlinkSync(temp); }
  }
  function read(meta) {
    try {
      const bytes = fs.readFileSync(filePath(meta.sha256));
      if (bytes.length !== meta.size || hash(bytes) !== meta.sha256 || !validMime(meta.mime, bytes)) throw new Error('凭证原图缺失或校验失败');
      return `data:${meta.mime};base64,${bytes.toString('base64')}`;
    } catch (error) { throw Object.assign(error, { status: 500 }); }
  }
  function prepare(raw) {
    if (!KINDS.includes(raw?.kind)) throw invalid('请选择凭证类型');
    if (typeof raw.client_id !== 'string' || !/^[A-Za-z0-9_-]{16,100}$/.test(raw.client_id)) throw invalid('凭证提交编号无效');
    if (typeof raw.name !== 'string' || !raw.name.trim() || raw.name.length > 160 || /[\x00-\x1f]/.test(raw.name)) throw invalid('照片名称无效');
    return { ...decode(raw.data), name: path.basename(raw.name.replace(/\\/g, '/')), kind: raw.kind, client_id: raw.client_id };
  }
  function add(entry, upload, source) {
    if (entry.voided_at) throw invalid('流水已作废，无法添加凭证');
    const attachments = entry.attachments || [];
    const prior = attachments.find(item => item.client_id === upload.client_id);
    if (prior && (prior.sha256 !== upload.sha256 || prior.kind !== upload.kind || prior.name !== upload.name)) throw invalid('同一提交编号不能更换照片');
    const duplicate = prior || attachments.find(item => item.sha256 === upload.sha256 && item.kind === upload.kind);
    if (duplicate) return duplicate;
    if (attachments.length >= MAX_ATTACHMENTS) throw invalid('每笔流水最多保存 20 张凭证');
    try { write(upload.bytes, upload.sha256); }
    catch (error) { throw Object.assign(error, { status: 500 }); }
    const meta = { id: crypto.randomBytes(24).toString('hex'), ledger_id: entry.id, client_id: upload.client_id, kind: upload.kind, name: upload.name, mime: upload.mime, size: upload.bytes.length, sha256: upload.sha256, created_at: Date.now(), status: 'unreviewed', source };
    entry.attachments = [...attachments, meta];
    return meta;
  }
  function metadata(snapshot) {
    const found = []; const ids = new Set();
    const transactions = new Map((snapshot.transactions || []).map(row => [row.id, row]));
    for (const entry of snapshot.ledger || []) {
      if (entry.attachments === undefined) continue;
      if (!Array.isArray(entry.attachments) || entry.attachments.length > MAX_ATTACHMENTS) throw invalid('凭证索引无效');
      for (const item of entry.attachments) {
        const transaction = transactions.get(entry.transaction_id);
        if (!item || !/^[a-f0-9]{48}$/.test(item.id) || ids.has(item.id) || item.ledger_id !== entry.id || !KINDS.includes(item.kind)
          || !/^[a-f0-9]{64}$/.test(item.sha256) || !Number.isSafeInteger(item.size) || item.size <= 0 || item.size > MAX_IMAGE_BYTES
          || !['image/jpeg', 'image/png', 'image/webp'].includes(item.mime) || item.status !== 'unreviewed'
          || !Number.isSafeInteger(item.created_at) || item.created_at < 0 || typeof item.name !== 'string' || item.name.length > 160
          || !/^[A-Za-z0-9_-]{16,100}$/.test(item.client_id) || !item.source
          || item.source.amount !== entry.amount || item.source.ledger_created_at !== entry.created_at
          || (item.source.party_id || null) !== (entry.party_id || null)
          || (item.source.party_type || null) !== (entry.party_type || null) || item.source.party_name !== (entry.party_name || '')
          || (item.source.delivery_note_id || null) !== (entry.delivery_note_id || transaction?.delivery_note_id || null)
          || item.source.document_no !== (transaction?.outbound_no || transaction?.order_no || '')
          || (item.source.transaction_id || null) !== (entry.transaction_id || null)) throw invalid('凭证索引或流水关联无效');
        ids.add(item.id); found.push(item);
      }
    }
    return found;
  }
  function portable(snapshot, maxBytes = Infinity) {
    const items = metadata(snapshot);
    if (!items.length) return snapshot;
    const unique = new Map(items.map(item => [item.sha256, item]));
    const estimate = Buffer.byteLength(JSON.stringify(snapshot)) + [...unique.values()].reduce((sum, item) => sum + Math.ceil(item.size / 3) * 4 + 120, 1024);
    if (estimate > maxBytes) throw invalid('含照片的备份超过服务器备份大小限制，请先调整备份容量');
    const files = {};
    for (const item of items) if (!files[item.sha256]) files[item.sha256] = read(item);
    return { ...snapshot, ledger_attachment_files: files };
  }
  function restore(snapshot) {
    const items = metadata(snapshot);
    const files = snapshot.ledger_attachment_files;
    const expected = new Set(items.map(item => item.sha256));
    if (files !== undefined && (!files || typeof files !== 'object' || Array.isArray(files) || Object.keys(files).some(key => !expected.has(key)))) throw invalid('备份包含未关联的凭证文件');
    const decoded = new Map();
    for (const item of items) {
      if (!files || !Object.prototype.hasOwnProperty.call(files, item.sha256)) throw invalid('备份缺少凭证原图，无法恢复');
      const value = decoded.get(item.sha256) || decode(files[item.sha256]);
      if (value.sha256 !== item.sha256 || value.mime !== item.mime || value.bytes.length !== item.size) throw invalid('备份凭证校验失败');
      decoded.set(item.sha256, value);
    }
    // Validate the complete bundle before writing any files. A later database
    // failure may leave an unreferenced immutable file, never a partial index.
    try { for (const [sha256, value] of decoded) write(value.bytes, sha256); }
    catch (error) { throw Object.assign(error, { status: 500 }); }
  }
  return { prepare, add, read, portable, restore };
}

module.exports = { createStore, MAX_IMAGE_BYTES, MAX_ATTACHMENTS, JSON_LIMIT, structurallyValid };
