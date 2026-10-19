'use strict';

const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');

function digest(bytes) {
  return crypto.createHash('sha256').update(bytes).digest('hex');
}

function verify(file, expectedCommit) {
  const source = fs.readFileSync(file, 'utf8').replace(/^\ufeff/, '');
  let bundle;
  try {
    bundle = JSON.parse(source);
  } catch (error) { throw new Error(`backend bundle JSON is invalid: ${error.message}`); }
  const commit = expectedCommit || process.env.RELEASE_COMMIT || '';
  if (bundle.format !== 'warehouse-backend-release-v1') throw new Error('backend release bundle format is invalid');
  if (!/^[a-f0-9]{40,64}$/.test(bundle.commit) || bundle.commit !== commit) throw new Error('backend release commit does not match');
  if (!bundle.files || typeof bundle.files !== 'object' || Array.isArray(bundle.files) || !Object.keys(bundle.files).length) throw new Error('backend release has no files');
  for (const [name, meta] of Object.entries(bundle.files)) {
    if (name.split('/').some(part => !/^[A-Za-z0-9_.-]+$/.test(part) || part === '.' || part === '..')) throw new Error('backend release path is unsafe: ' + name);
    if (!meta || !Number.isSafeInteger(meta.size) || meta.size < 0 || !/^[a-f0-9]{64}$/.test(meta.sha256) || !/^[A-Za-z0-9+/]*={0,2}$/.test(meta.data || '')) throw new Error('backend release metadata is invalid: ' + name);
    const bytes = Buffer.from(meta.data, 'base64');
    if (bytes.length !== meta.size || digest(bytes) !== meta.sha256) throw new Error('backend release content mismatch: ' + name);
    if (bytes.includes(0)) throw new Error('backend release content contains NUL: ' + name);
    if ((name.endsWith('.json') || name.endsWith('.json.gz')) && !name.startsWith('node_modules/') && !name.endsWith('data.json')) {
      const json = bytes.toString('utf8').replace(/^\ufeff/, '');
      if (json.trimStart().startsWith('\ufeff')) continue;
      JSON.parse(json);
    }
  }
  for (const required of ['server.js', 'db.js', 'team.js', 'daily-backup.js', 'product-image-backup.js', 'ledger-attachments.js', 'business-workflow.js', 'package.json', 'package-lock.json']) {
    if (!bundle.files[required]) throw new Error('backend release is missing: ' + required);
  }
  const packageJson = JSON.parse(Buffer.from(bundle.files['package.json'].data, 'base64').toString('utf8'));
  if (packageJson.name !== 'shuguang-server' || !packageJson.dependencies?.express) throw new Error('backend package contract is invalid');
  return { commit: bundle.commit, files: Object.keys(bundle.files).sort() };
}

if (require.main === module) {
  try {
    const file = process.argv[2];
    if (!file) throw new Error('usage: node scripts/verify-backend-release.js release-bundle.json [commit]');
    const result = verify(path.resolve(file), process.argv[3]);
    process.stdout.write(JSON.stringify(result) + '\n');
  } catch (error) { console.error(error.message); process.exitCode = 1; }
}

module.exports = { verify };
