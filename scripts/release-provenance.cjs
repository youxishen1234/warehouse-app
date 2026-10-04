const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const { execFileSync } = require('node:child_process');
const root = path.resolve(__dirname, '..');
const output = path.resolve(process.argv[2] || 'dist');
const commit = execFileSync('git', ['rev-parse', 'HEAD'], { cwd: root, encoding: 'utf8' }).trim();
if (execFileSync('git', ['status', '--porcelain', '--untracked-files=normal', '--', 'src', 'config', 'prototypes', 'scripts', 'package.json', 'package-lock.json'], { cwd: root, encoding: 'utf8' }).trim()) throw new Error('Cannot attest an uncommitted source tree');
const files = execFileSync('git', ['ls-files', '-z', 'src', 'config', 'prototypes', 'scripts', 'package.json', 'package-lock.json', 'www/js/home-search.js', 'www/css/polish.css'], { cwd: root }).toString().split('\0').filter(Boolean).sort();
const hash = crypto.createHash('sha256');
for (const name of files) { hash.update(name + '\0'); hash.update(fs.readFileSync(path.join(root, name))); }
fs.writeFileSync(path.join(output, 'release-info.json'), JSON.stringify({ commit, sourceSha256: hash.digest('hex') }, null, 2));
