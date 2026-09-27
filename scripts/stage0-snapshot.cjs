'use strict';
// Explicit input only; never imports db.js or restores over an existing directory.
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const hash = bytes => crypto.createHash('sha256').update(bytes).digest('hex');
function validate(bytes) {
  const data = JSON.parse(bytes.toString('utf8'));
  for (const key of ['products', 'customers', 'suppliers', 'transactions', 'ledger'])
    if (!Array.isArray(data[key])) throw new Error('Invalid collection: ' + key);
  return Object.fromEntries(Object.entries(data).filter(([, v]) => Array.isArray(v)).map(([k, v]) => [k, v.length]));
}
function resolveChild(root, name) {
  if (typeof name !== 'string' || path.isAbsolute(name)) throw new Error('Unsafe manifest path');
  const target = path.resolve(root, name), relative = path.relative(root, target);
  if (!relative || relative.startsWith('..') || path.isAbsolute(relative)) throw new Error('Unsafe manifest path');
  let current = path.resolve(root);
  for (const part of relative.split(path.sep)) {
    current = path.join(current, part);
    if (fs.existsSync(current) && fs.lstatSync(current).isSymbolicLink()) throw new Error('Symlink is not supported');
  }
  return target;
}
function walk(root, dir = root) {
  if (fs.lstatSync(dir).isSymbolicLink()) throw new Error('Symlink is not supported');
  return fs.readdirSync(dir, { withFileTypes: true }).flatMap(entry => {
    const source = path.join(dir, entry.name);
    if (entry.isSymbolicLink()) throw new Error('Symlink is not supported');
    if (entry.isDirectory()) return walk(root, source);
    if (!entry.isFile()) throw new Error('Unsupported source');
    return [{ source, name: 'uploads/' + path.relative(root, source).split(path.sep).join('/') }];
  }).sort((a, b) => a.name.localeCompare(b.name));
}
function verify(directory) {
  const manifest = JSON.parse(fs.readFileSync(path.join(directory, 'manifest.json'), 'utf8'));
  if (manifest.format !== 1 || !Array.isArray(manifest.files) || !manifest.files.some(x => x.name === 'data.json')) throw new Error('Invalid manifest');
  const seen = new Set();
  for (const item of manifest.files) {
    if (seen.has(item.name)) throw new Error('Duplicate entry');
    seen.add(item.name);
    const bytes = fs.readFileSync(resolveChild(directory, item.name));
    if (bytes.length !== item.bytes || hash(bytes) !== item.sha256) throw new Error('Checksum mismatch: ' + item.name);
  }
  validate(fs.readFileSync(path.join(directory, 'data.json')));
  return manifest;
}
function capture(sourceFile, output, uploads, fixture = false) {
  const source = path.resolve(sourceFile), target = path.resolve(output);
  const bytes = fs.readFileSync(source), counts = validate(bytes);
  if (fs.existsSync(target)) throw new Error('Snapshot target already exists');
  if (uploads) {
    const relative = path.relative(path.resolve(uploads), target);
    if (!relative || (!relative.startsWith('..') && !path.isAbsolute(relative))) throw new Error('Snapshot cannot be inside uploads');
  }
  const entries = [{ source, name: 'data.json', bytes }, ...(uploads ? walk(path.resolve(uploads)) : [])];
  const manifest = { format: 1, createdAt: new Date().toISOString(), fixture, assetsIncluded: Boolean(uploads), counts, files: [] };
  fs.mkdirSync(target, { recursive: true });
  // No manifest is written until a complete, source-stable capture has passed.
  for (const entry of entries) {
    const contents = entry.bytes || fs.readFileSync(entry.source), dest = resolveChild(target, entry.name);
    fs.mkdirSync(path.dirname(dest), { recursive: true });
    fs.writeFileSync(dest, contents, { flag: 'wx', mode: 0o600 });
    manifest.files.push({ name: entry.name, bytes: contents.length, sha256: hash(contents) });
  }
  entries.forEach((entry, i) => {
    if (hash(fs.readFileSync(entry.source)) !== manifest.files[i].sha256) throw new Error('Source changed during capture; pause writes and retry');
  });
  if (uploads && JSON.stringify(walk(path.resolve(uploads)).map(x => x.name)) !== JSON.stringify(entries.slice(1).map(x => x.name))) throw new Error('Upload list changed during capture');
  fs.writeFileSync(path.join(target, 'manifest.json'), JSON.stringify(manifest, null, 2), { flag: 'wx', mode: 0o600 });
  return verify(target);
}
function restore(snapshot, output) {
  const manifest = verify(path.resolve(snapshot)), target = path.resolve(output);
  if (fs.existsSync(target)) throw new Error('Restore target must not exist');
  fs.mkdirSync(target, { recursive: true });
  for (const item of manifest.files) {
    const bytes = fs.readFileSync(resolveChild(path.resolve(snapshot), item.name));
    if (hash(bytes) !== item.sha256) throw new Error('Snapshot changed during restore');
    const dest = resolveChild(target, item.name);
    fs.mkdirSync(path.dirname(dest), { recursive: true });
    fs.writeFileSync(dest, bytes, { flag: 'wx', mode: 0o600 });
    if (hash(fs.readFileSync(dest)) !== item.sha256) throw new Error('Restore checksum mismatch');
  }
  validate(fs.readFileSync(path.join(target, 'data.json')));
  return { verified: true, fixture: manifest.fixture, files: manifest.files.length, counts: manifest.counts };
}
module.exports = { capture, verify, restore };
if (require.main === module) {
  try {
    const [command, source, output, ...rest] = process.argv.slice(2);
    if (!source || !['capture', 'verify', 'restore'].includes(command) || (command !== 'verify' && !output)) throw new Error('Usage: capture DATA NEW_DIR [UPLOADS] [--fixture] | verify SNAPSHOT | restore SNAPSHOT NEW_DIR');
    console.log(JSON.stringify(command === 'verify' ? verify(source) : command === 'restore' ? restore(source, output) : capture(source, output, rest.find(x => x !== '--fixture'), rest.includes('--fixture')), null, 2));
  } catch (error) { console.error(error.message); process.exitCode = 1; }
}
