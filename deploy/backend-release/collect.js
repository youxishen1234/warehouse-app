'use strict';

const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');

const SOURCE_ROOT = path.resolve(__dirname, '..', '..');
const BACKEND_ROOT = path.join(SOURCE_ROOT, 'backend');
function digest(bytes) {
  return crypto.createHash('sha256').update(bytes).digest('hex');
}

function collect() {
  const queue = [
    'ai.js',
    'ai-provider.js',
    'ai-settings.js',
    'ai-speech-worker.py',
    'ai-speech.js',
    'ai-tools.js',
    'backup-limits.js',
    'boards.js',
    'business-workflow.js',
    'customer-dimensions.js',
    'daily-backup.js',
    'date-query.js',
    'db.js',
    'graceful-shutdown.js',
    'ledger-attachments.js',
    'list-sort.js',
    'print-notes.js',
    'product-image-backup.js',
    'rate-limit.js',
    'remote-print.js',
    'server.js',
    'stock-math.js',
    'team.js',
    'update-version.js',
    'updates.js'
  ];
  const seen = new Set();
  while (queue.length) {
    const name = queue.shift();
    if (seen.has(name)) continue;
    seen.add(name);
    const file = path.join(BACKEND_ROOT, name);
    const source = fs.readFileSync(file, 'utf8');
    for (const match of source.matchAll(/require\(['"]\.\/([^'"]+)['"]\)/g)) {
      const dependency = path.posix.normalize(match[1]);
      if (dependency.startsWith('../') || path.posix.isAbsolute(dependency)) throw new Error(`Unsafe local dependency: ${name} -> ${dependency}`);
      const candidate = [dependency, dependency + '.js', path.posix.join(dependency, 'index.js')]
        .find(relative => fs.existsSync(path.join(BACKEND_ROOT, relative)) && fs.statSync(path.join(BACKEND_ROOT, relative)).isFile());
      if (!candidate) throw new Error(`Missing local dependency: ${name} -> ${dependency}`);
      queue.push(candidate);
    }
  }
  return [...seen].sort();
}

function main() {
  const backendFiles = collect();
  const files = [
    ['package.json', fs.readFileSync(path.join(BACKEND_ROOT, 'package.json'))],
    ['package-lock.json', fs.readFileSync(path.join(BACKEND_ROOT, 'package-lock.json'))],
    ...backendFiles.map(name => [name, fs.readFileSync(path.join(BACKEND_ROOT, name))])
  ];
  const packageLock = JSON.parse(fs.readFileSync(path.join(BACKEND_ROOT, 'package-lock.json'), 'utf8'));
  for (const dependency of Object.keys(packageLock.packages || {})) {
    if (!dependency.startsWith('node_modules/')) continue;
    const directory = path.join(BACKEND_ROOT, dependency);
    if (!fs.existsSync(directory)) throw new Error(`Missing installed dependency: ${dependency}`);
    const pending = [directory];
    while (pending.length) {
      const current = pending.pop();
      for (const entry of fs.readdirSync(current, { withFileTypes: true })) {
        if (entry.name === '.bin' || entry.name === '.cache') continue;
        const full = path.join(current, entry.name);
        if (entry.isDirectory()) { pending.push(full); continue; }
        if (!entry.isFile()) throw new Error(`unsupported dependency entry: ${full}`);
        const name = path.relative(BACKEND_ROOT, full).split(path.sep).join('/');
        const bytes = fs.readFileSync(full);
        if (bytes.includes(0) && !name.endsWith('.node')) throw new Error(`binary dependency is not supported: ${name}`);
        files.push([name, bytes]);
      }
    }
  }
  const manifest = {
    format: 'warehouse-backend-release-v1',
    commit: process.env.RELEASE_COMMIT || '',
    createdAt: new Date().toISOString(),
    files: Object.fromEntries(files.map(([name, bytes]) => [name, { size: bytes.length, sha256: digest(bytes), data: bytes.toString('base64') }]))
  };
  if (!/^[a-f0-9]{40,64}$/.test(manifest.commit)) throw new Error('RELEASE_COMMIT must be a full Git commit');
  process.stderr.write(JSON.stringify({ backendFiles }) + '\n');
  process.stdout.write(JSON.stringify(manifest, null, 2) + '\n');
}

if (require.main === module) {
  try { main(); } catch (error) { console.error(error.message); process.exitCode = 1; }
}

module.exports = { collect };
