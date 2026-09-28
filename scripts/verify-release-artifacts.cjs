const fs = require('node:fs/promises');
const path = require('node:path');
const { createHash } = require('node:crypto');
const { readArchive } = require('./prepare-download.cjs');

const textExtensions = new Set(['.css', '.html', '.js', '.json', '.svg', '.txt']);
const secretPatterns = [
  /-----BEGIN(?: [A-Z]+)? PRIVATE KEY-----/,
  /\bAKIA[0-9A-Z]{16}\b/,
  /\b(?:ghp|github_pat|xox[baprs])_[A-Za-z0-9_\-]{20,}\b/,
  /\bsk-[A-Za-z0-9]{20,}\b/,
  /\bAuthorization\s*[:=]\s*Bearer\s+[A-Za-z0-9._\-]{20,}/i,
];

const digest = bytes => createHash('sha256').update(bytes).digest('hex');

async function listFiles(root) {
  const result = [];
  async function visit(directory) {
    for (const entry of await fs.readdir(directory, { withFileTypes: true })) {
      const full = path.join(directory, entry.name);
      if (entry.isSymbolicLink()) throw new Error(`symlink is not allowed in release assets: ${full}`);
      if (entry.isDirectory()) await visit(full);
      else if (entry.isFile()) result.push(full);
      else throw new Error(`unsupported filesystem entry: ${full}`);
    }
  }
  await visit(root);
  return result;
}

function relativeName(root, filename) {
  return path.relative(root, filename).split(path.sep).join('/');
}

function scanText(name, text) {
  if (/(?:^|\r?\n)\s*(?:\/\/|\/\*)[#@]\s*sourceMappingURL=/i.test(text)) {
    throw new Error(`source map reference is not allowed: ${name}`);
  }
  for (const pattern of secretPatterns) {
    if (pattern.test(text)) throw new Error(`credential-like value found in release asset: ${name}`);
  }
}

async function verifyDirectory(directory) {
  const root = path.resolve(directory);
  const stat = await fs.stat(root);
  if (!stat.isDirectory()) throw new Error(`release directory is not a directory: ${root}`);
  const files = await listFiles(root);
  const names = new Set(files.map(file => relativeName(root, file)));
  if (!names.has('index.html')) throw new Error('release directory must contain index.html');
  for (const file of files) {
    const name = relativeName(root, file);
    if (name.toLowerCase().endsWith('.map')) throw new Error(`source map is not allowed: ${name}`);
    if (textExtensions.has(path.extname(name).toLowerCase())) {
      const text = await fs.readFile(file, 'utf8');
      scanText(name, text);
    }
  }
  return { root, files, names };
}

async function verifyZip(zipPath, directoryInfo) {
  const archive = await readArchive(zipPath, () => true);
  const normalizedArchive = new Map();
  const zipNames = new Set();
  for (const [name] of archive) {
    const normalized = name.replaceAll('\\', '/');
    if (normalized.startsWith('/') || normalized.split('/').includes('..')) {
      throw new Error(`unsafe archive path: ${name}`);
    }
    if (normalized.endsWith('/')) continue;
    if (zipNames.has(normalized)) throw new Error(`duplicate archive entry: ${normalized}`);
    zipNames.add(normalized);
    normalizedArchive.set(normalized, archive.get(name));
    if (normalized.toLowerCase().endsWith('.map')) throw new Error(`source map is not allowed: ${normalized}`);
    if (textExtensions.has(path.posix.extname(normalized).toLowerCase())) {
      scanText(normalized, normalizedArchive.get(normalized).toString('utf8'));
    }
  }
  const expectedNames = [...directoryInfo.names].sort();
  const actualNames = [...zipNames].sort();
  if (expectedNames.length !== actualNames.length || expectedNames.some((name, index) => name !== actualNames[index])) {
    const missing = expectedNames.filter(name => !zipNames.has(name));
    const extra = actualNames.filter(name => !directoryInfo.names.has(name));
    throw new Error(`archive file set differs from release directory (missing: ${missing.join(', ') || 'none'}; extra: ${extra.join(', ') || 'none'})`);
  }
  for (const file of directoryInfo.files) {
    const name = relativeName(directoryInfo.root, file);
    const expected = await fs.readFile(file);
    const actual = normalizedArchive.get(name);
    if (!actual || digest(expected) !== digest(actual)) throw new Error(`archive hash differs from release directory: ${name}`);
  }
  return { zip: path.resolve(zipPath), files: archive.size };
}

async function main(argv = process.argv.slice(2)) {
  let directory = 'dist';
  let zip;
  let json = false;
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === '--dist') directory = argv[++index];
    else if (arg === '--zip') zip = argv[++index];
    else if (arg === '--json') json = true;
    else throw new Error(`unknown argument: ${arg}`);
  }
  if (!directory || (zip !== undefined && !zip)) throw new Error('usage: --dist <directory> [--zip <archive>] [--json]');
  const directoryInfo = await verifyDirectory(directory);
  const result = { dist: directoryInfo.root, files: directoryInfo.files.length };
  if (zip) Object.assign(result, await verifyZip(zip, directoryInfo));
  if (json) process.stdout.write(`${JSON.stringify(result)}\n`);
  else process.stdout.write(`release assets verified: ${result.files} files${result.zip ? `; archive matches ${result.zip}` : ''}\n`);
  return result;
}

if (require.main === module) {
  main().catch(error => { console.error(`release artifact verification failed: ${error.message}`); process.exitCode = 1; });
}

module.exports = { main, verifyDirectory, verifyZip };
