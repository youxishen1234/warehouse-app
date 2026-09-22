const fs = require('node:fs/promises');
const path = require('node:path');
const { createHash } = require('node:crypto');
const { readArchive } = require('./prepare-download.cjs');

const digest = bytes => createHash('sha256').update(bytes).digest('hex');
const decode = text => text.replace(/\\u([0-9a-f]{4})/gi, (_, hex) => String.fromCharCode(parseInt(hex, 16)));
const terms = /供货商|供应商管理|欠款|结清|suppliers|settle/gi;

async function inspect(filename) {
  const files = await readArchive(filename, name => /\.(html|js)$/.test(name) || name.endsWith('capacitor.config.json'));
  const report = { archive: path.basename(filename), files: [] };
  for (const [name, bytes] of files) {
    if (name.endsWith('capacitor.config.json')) {
      report.capacitor = JSON.parse(bytes.toString('utf8'));
      continue;
    }
    const text = decode(bytes.toString('utf8'));
    const matches = [...text.matchAll(terms)];
    const localName = name.replace(/^Payload\/[^/]+\.app\/public\//, '');
    const local = await fs.readFile(path.join('www', localName)).catch(() => null);
    report.files.push({
      name,
      matchesWorkspace: local ? digest(bytes) === digest(local) : null,
      featureMatches: matches.length,
      examples: matches.slice(-14).map(match => text.slice(Math.max(0, match.index - 70), match.index + 150)),
    });
  }
  console.log(JSON.stringify(report, null, 2));
}

inspect(process.argv[2]).catch(error => { console.error(error.message); process.exitCode = 1; });
