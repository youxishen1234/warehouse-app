'use strict';

const fs = require('node:fs');
const path = require('node:path');

const bundleFile = process.argv[2];
const output = process.argv[3];
if (!bundleFile || !output) throw new Error('usage: node materialize.js bundle.json output-directory');
const bundle = JSON.parse(fs.readFileSync(bundleFile, 'utf8').replace(/^\ufeff/, ''));
if (bundle.format !== 'warehouse-backend-release-v1' || !bundle.files) throw new Error('invalid backend bundle');
fs.mkdirSync(output, { recursive: true });
for (const [name, metadata] of Object.entries(bundle.files)) {
  if (name.split('/').some(part => !/^[A-Za-z0-9_.-]+$/.test(part) || part === '.' || part === '..')) throw new Error('unsafe bundle path');
  const target = path.resolve(output, name);
  if (!target.startsWith(path.resolve(output) + path.sep)) throw new Error('bundle escapes output');
  fs.mkdirSync(path.dirname(target), { recursive: true });
  fs.writeFileSync(target, Buffer.from(metadata.data, 'base64'), { flag: 'wx' });
}
process.stdout.write(output + '\n');
