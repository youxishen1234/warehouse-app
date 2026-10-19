// The API server owns this schedule, not a phone/browser background timer.
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const { gzip, gunzip, createGzip, createGunzip } = require('node:zlib');
const { Readable, Transform } = require('node:stream');
const { pipeline } = require('node:stream/promises');
const { promisify } = require('node:util');
const compress = promisify(gzip), decompress = promisify(gunzip);
const DAY = 86400000, OFFSET = 8 * 3600000;
const FILE = /^daily-(\d{4}-\d{2}-\d{2})\.json\.gz$/;
const sha256 = bytes => crypto.createHash('sha256').update(bytes).digest('hex');
async function* jsonRows(rows) {
  yield '[';
  for (let index = 0; index < rows.length; index += 1) {
    if (index) yield ',';
    yield JSON.stringify(rows[index]);
    if (index % 128 === 0) await new Promise(resolve => setImmediate(resolve));
  }
  yield ']';
}
// Hash the exact data JSON without retaining its serialized copy. The daily
// snapshot signature is intentionally compatible with the previous export.
async function dataDigest(data) {
  const chunks = async function* (value) {
    if (value === null || typeof value !== 'object') { yield Buffer.from(JSON.stringify(value)); return; }
    const array = Array.isArray(value), entries = array ? value : Object.values(value);
    const keys = array ? null : Object.keys(value);
    yield Buffer.from(array ? '[' : '{');
    for (let index = 0; index < entries.length; index += 1) {
      if (index) yield Buffer.from(',');
      if (keys) yield Buffer.from(JSON.stringify(keys[index]) + ':');
      yield* chunks(entries[index]);
      if (index % 128 === 0) await new Promise(resolve => setImmediate(resolve));
    }
    yield Buffer.from(array ? ']' : '}');
  };
  const hash = crypto.createHash('sha256');
  const sink = new Transform({
    transform(chunk, encoding, callback) { hash.update(chunk); callback(); },
    flush(callback) { this.sha256 = hash.digest('hex'); callback(); }
  });
  await pipeline(Readable.from(chunks(data), { objectMode: false }), sink);
  return sink.sha256;
}
// Avoid body-parser and JSON.stringify complete copies for backups containing
// original photos. The object key order matches JSON.stringify for top-level
// fields so the signed data payload remains byte-for-byte stable.
function backupJson(data, payload) {
  const keys = Object.keys(data), payloadKeys = Object.keys(payload);
  return Readable.from((async function* () {
    yield '{';
    for (let index = 0; index < payloadKeys.length + 1; index += 1) {
      if (index) yield ',';
      const key = index < payloadKeys.length ? payloadKeys[index] : 'data';
      const value = index < payloadKeys.length ? payload[key] : data;
      yield JSON.stringify(key) + ':';
      if (key === 'data') {
        yield '{';
        for (let field = 0; field < keys.length; field += 1) {
          if (field) yield ',';
          yield JSON.stringify(keys[field]) + ':';
          if (Array.isArray(data[keys[field]])) yield* jsonRows(data[keys[field]]);
          else yield JSON.stringify(data[keys[field]]);
        }
        yield '}';
      } else yield JSON.stringify(value);
    }
    yield '}';
  })());
}
function scheduledDay(now, hour = 2) { return new Date(now + OFFSET - hour * 3600000).toISOString().slice(0, 10); }
function nextScheduledAt(now, hour = 2) {
  return new Date(Date.parse(scheduledDay(now, hour) + 'T00:00:00Z') - OFFSET + hour * 3600000 + DAY).toISOString();
}
async function atomicWrite(file, bytes, publishOnce = false) {
  const temp = file + '.tmp-' + process.pid + '-' + crypto.randomBytes(6).toString('hex');
  try {
    const handle = await fs.promises.open(temp, 'wx', 0o600);
    try { await handle.writeFile(bytes); await handle.sync(); } finally { await handle.close(); }
    if (publishOnce) await fs.promises.link(temp, file); else await fs.promises.rename(temp, file);
    try { const dir = await fs.promises.open(path.dirname(file), 'r'); try { await dir.sync(); } finally { await dir.close(); } } catch { /* Windows lacks directory fsync. */ }
  } finally { await fs.promises.unlink(temp).catch(() => {}); }
}
async function readSnapshot(file, maxBytes) {
  const meta = await fs.promises.lstat(file);
  if (!meta.isFile() || meta.isSymbolicLink() || meta.size > maxBytes + 65536) throw new Error('每日备份文件无效');
  const zipped = await fs.promises.readFile(file), raw = await decompress(zipped, { maxOutputLength: maxBytes });
  const payload = JSON.parse(raw.toString('utf8'));
  if (payload.format !== 'warehouse-daily-v1' || !/^\d{4}-\d{2}-\d{2}$/.test(payload.scheduledDay)
    || !Number.isFinite(Date.parse(payload.exportedAt)) || !Number.isSafeInteger(payload.revision) || payload.revision < 0
    || !payload.data || payload.sha256 !== sha256(JSON.stringify(payload.data))) throw new Error('每日备份完整性校验失败');
  if (payload.data._collaboration?.revision !== undefined && payload.data._collaboration.revision !== payload.revision) throw new Error('每日备份版本不一致');
  return { payload, bytes: zipped.length };
}
function createDailyBackup(db, options = {}) {
  const env = options.env || process.env, now = options.now || Date.now, logger = options.logger || console;
  const dataFile = env.WAREHOUSE_DATA_FILE || path.join(__dirname, 'data.json');
  const directory = path.resolve(options.directory || env.WAREHOUSE_DAILY_BACKUP_DIR || path.join(env.WAREHOUSE_BACKUP_DIR || path.join(path.dirname(dataFile), 'backups'), 'daily'));
  const configuredHour = Number(env.WAREHOUSE_DAILY_BACKUP_HOUR ?? 2);
  const hour = Number.isInteger(configuredHour) && configuredHour >= 0 && configuredHour <= 23 ? configuredHour : 2;
  const keep = Math.max(1, Math.min(365, Math.trunc(Number(env.WAREHOUSE_DAILY_BACKUP_KEEP) || 30)));
  const maxBytes = options.maxBytes || require('./backup-limits').BACKUP_MAX_BYTES;
  const enabled = env.WAREHOUSE_DAILY_BACKUP_ENABLED !== 'false', validated = new Map();
  const stateFile = path.join(directory, 'status.json');
  let running = null, timer = null, active = false, retryAt = 0, lastSuccess = null, lastAttemptAt = null;
  let operationError = null, verificationError = null, scanGeneration = 0;
  try {
    const saved = JSON.parse(fs.readFileSync(stateFile, 'utf8'));
    if (Number.isFinite(Date.parse(saved.lastAttemptAt))) lastAttemptAt = saved.lastAttemptAt;
    if (saved.failed === true) { operationError = '上次每日备份未完成，服务器将自动重试。'; retryAt = Math.min(now() + 15 * 60000, Number(saved.retryAt) || 0); }
  } catch { /* Advisory status is not proof of a successful backup. */ }
  const publicRoots = [path.join(__dirname, 'public'), env.WAREHOUSE_WEB_ROOT].filter(Boolean).map(root => path.resolve(root));
  const configurationError = publicRoots.some(root => { const rel = path.relative(root, directory); return rel === '' || (!rel.startsWith('..' + path.sep) && rel !== '..' && !path.isAbsolute(rel)); }) ? '备份目录必须位于公开网页目录之外。' : null;
  async function names() {
    try { return (await fs.promises.readdir(directory)).filter(name => FILE.test(name) && name.slice(6, 16) <= scheduledDay(now(), hour)).sort().reverse(); }
    catch (error) { if (error.code === 'ENOENT') return []; throw error; }
  }
  async function verify(name, includeData = false) {
    const file = path.join(directory, name), stat = await fs.promises.lstat(file);
    const signature = [stat.size, stat.mtimeMs, stat.ctimeMs, stat.ino].join(':');
    if (!includeData && validated.get(name)?.signature === signature) return validated.get(name).value;
    const saved = await readSnapshot(file, maxBytes);
    if (saved.payload.scheduledDay !== name.slice(6, 16)) throw new Error('每日备份日期不匹配');
    if (db.validateBackup) db.validateBackup(saved.payload.data);
    const value = { name, day: saved.payload.scheduledDay, exportedAt: saved.payload.exportedAt, bytes: saved.bytes };
    validated.set(name, { signature, value });
    return includeData ? { ...value, payload: saved.payload } : value;
  }
  async function refreshLatest() {
    const generation = ++scanGeneration;
    if (configurationError) return;
    let candidate = null, error = null;
    for (const name of await names()) {
      try { candidate = await verify(name); break; }
      catch { error = '发现损坏或不完整的备份，已保留原文件；请检查服务器。'; }
    }
    if (generation === scanGeneration) { lastSuccess = candidate; verificationError = error; }
  }
  async function rotate() {
    const candidates = await names(); if (candidates.length <= keep) return;
    let good = 0;
    for (const name of candidates) {
      try { await verify(name); } catch { continue; }
      if (++good > keep) { await fs.promises.unlink(path.join(directory, name)).catch(error => { if (error.code !== 'ENOENT') throw error; }); validated.delete(name); }
    }
  }
  async function finalizeSuccess(name) {
    scanGeneration += 1;
    lastSuccess = await verify(name);
    operationError = null;
    verificationError = null;
    retryAt = 0;
    await atomicWrite(stateFile, JSON.stringify({ lastAttemptAt, failed: false, retryAt: 0 }));
    await rotate().catch(error => {
      logger.warn('[daily-backup] retention cleanup failed:', error.message);
      operationError = '备份已保存，但旧副本清理失败，请检查服务器存储空间。';
    });
  }
  async function perform() {
    if (configurationError) throw new Error(configurationError);
    const at = now(), day = scheduledDay(at, hour), name = 'daily-' + day + '.json.gz';
    await fs.promises.mkdir(directory, { recursive: true, mode: 0o700 });
    try { await finalizeSuccess(name); return false; }
    catch (error) { if (error.code !== 'ENOENT') throw error; }
    lastAttemptAt = new Date(at).toISOString();
    const data = db.backupData({ includeAttachments: true, maxBytes: maxBytes - 2048 });
    if (db.validateBackup) db.validateBackup(data);
    const payload = { format: 'warehouse-daily-v1', scheduledDay: day, exportedAt: lastAttemptAt, revision: db.revision(), sha256: await dataDigest(data) };
    const target = path.join(directory, name), temp = target + '.tmp-' + process.pid + '-' + crypto.randomBytes(6).toString('hex');
    let written = 0, rawBytes = 0, successful = false;
    try {
      const measured = new Transform({
        transform(chunk, encoding, callback) {
          rawBytes += chunk.length;
          if (rawBytes > maxBytes) return callback(new Error('备份超过容量上限'));
          callback(null, chunk);
        }
      });
      const metered = new Transform({
        transform(chunk, encoding, callback) {
          written += chunk.length;
          if (written > maxBytes) return callback(new Error('备份超过容量上限'));
          callback(null, chunk);
        }
      });
      await pipeline(backupJson(data, payload), measured, createGzip(), metered, fs.createWriteStream(temp, { flags: 'wx', mode: 0o600 }));
      const handle = await fs.promises.open(temp, 'r+');
      try { await handle.sync(); } finally { await handle.close(); }
      await fs.promises.link(temp, target);
      successful = true;
    } catch (error) {
      if (error.code !== 'EEXIST') throw error;
    } finally { await fs.promises.unlink(temp).catch(() => {}); }
    // A second streaming pass verifies the exact published member, rather
    // than trusting the compressor that just produced it.
    await verify(name);
    await finalizeSuccess(name);
    return successful;
  }
  function runDue() {
    if (!enabled || now() < retryAt) return Promise.resolve(false); if (running) return running;
    running = perform().catch(async error => {
      lastAttemptAt = new Date(now()).toISOString(); operationError = configurationError || '每日备份失败，15 分钟后自动重试；现有业务数据不受影响。'; retryAt = now() + 15 * 60000;
      logger.error('[daily-backup] failed:', error.message);
      if (!configurationError) await atomicWrite(stateFile, JSON.stringify({ lastAttemptAt, failed: true, retryAt })).catch(() => {});
      return false;
    }).finally(() => { running = null; }); return running;
  }
  function status() {
    return { enabled, active, timeZone: 'Asia/Shanghai', hour, keepDays: keep, lastSuccessAt: lastSuccess?.exportedAt || null, lastAttemptAt,
      lastError: configurationError || operationError || verificationError, nextScheduledAt: enabled && active ? nextScheduledAt(now(), hour) : null,
      nextRetryAt: enabled && retryAt ? new Date(retryAt).toISOString() : null, running: !!running, location: 'server', verified: !!lastSuccess };
  }
  async function getStatus() {
    await refreshLatest().catch(() => {
      scanGeneration += 1;
      lastSuccess = null;
      verificationError = '暂时无法检查服务器备份，请稍后重试。';
    });
    return status();
  }
  async function latest() {
    await refreshLatest(); if (!lastSuccess) throw Object.assign(new Error('服务器还没有可用的每日备份'), { status: 404 });
    const selected = lastSuccess.name;
    const saved = await verify(selected, true); return { exportedAt: saved.payload.exportedAt, data: saved.payload.data };
  }
  async function streamLatest(res) {
    await refreshLatest();
    if (!lastSuccess) throw Object.assign(new Error('服务器还没有可用的每日备份'), { status: 404 });
    const file = path.join(directory, lastSuccess.name);
    const raw = fs.createReadStream(file);
    const gzipStream = createGunzip({ maxOutputLength: maxBytes });
    res.type('application/json');
    try {
      // The gzip member has exactly one `{...}` object. Convert its outer
      // object into the existing `{ success, data }` response incrementally.
      let started = false;
      await pipeline(raw, gzipStream, async function* (sourceStream) {
        const decoder = new TextDecoder('utf-8', { fatal: true });
        for await (const chunk of sourceStream) {
          const text = decoder.decode(chunk, { stream: true });
          if (!started) {
            const brace = text.indexOf('{');
            if (brace < 0) continue;
            started = true;
            // Do not interpolate a chunk directly into a JavaScript string:
            // a multi-byte UTF-8 character can be split across chunks.
            yield Buffer.from('{"success":true,"data":', 'utf8');
            yield text.slice(brace);
          } else yield chunk;
        }
        const tail = decoder.decode();
        if (tail) yield tail;
        if (!started) throw new Error('每日备份内容无效');
        yield Buffer.from('}', 'utf8');
      }, res);
    } catch (error) {
      raw.destroy();
      throw error;
    }
  }
  function start() { if (active || !enabled || configurationError) return; active = true; void runDue(); timer = setInterval(() => { void runDue(); }, 60000); timer.unref(); }
  function stop() { clearInterval(timer); timer = null; active = false; return running || Promise.resolve(); }
  return { start, stop, status, getStatus, latest, streamLatest, runDue };
}
module.exports = { createDailyBackup, scheduledDay, nextScheduledAt, readSnapshot };
