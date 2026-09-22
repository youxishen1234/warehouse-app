const fs = require('node:fs/promises');
const path = require('node:path');
const { createHash } = require('node:crypto');
const yauzl = require('yauzl');
const bplist = require('bplist-parser');

function readArchive(filename, select) {
  return new Promise((resolve, reject) => {
    yauzl.open(filename, { lazyEntries: true }, (error, zip) => {
      if (error) return reject(error);
      const files = new Map();
      const fail = error => { zip.close(); reject(error); };
      zip.on('error', fail);
      zip.on('end', () => resolve(files));
      zip.on('entry', entry => {
        if (!select(entry.fileName) || entry.fileName.endsWith('/')) return zip.readEntry();
        if (entry.uncompressedSize > 64 * 1024 * 1024) return fail(new Error('Archive entry exceeds 64 MiB'));
        zip.openReadStream(entry, (error, stream) => {
          if (error) return fail(error);
          const chunks = [];
          stream.on('error', fail);
          stream.on('data', chunk => chunks.push(chunk));
          stream.on('end', () => {
            files.set(entry.fileName, Buffer.concat(chunks));
            zip.readEntry();
          });
        });
      });
      zip.readEntry();
    });
  });
}

async function prepareDownload(ipaPath, outputDir = 'release/download') {
  const plist = await import('plist');
  const files = await readArchive(ipaPath, name => /^Payload\/[^/]+\.app\/Info\.plist$/.test(name));
  if (files.size !== 1) throw new Error('Expected one Payload/*.app/Info.plist');
  const buffer = files.values().next().value;
  const info = buffer.subarray(0, 6).toString() === 'bplist'
    ? bplist.parseBuffer(buffer)[0] : plist.parse(buffer.toString('utf8'));
  if (!info.CFBundleShortVersionString || !info.CFBundleVersion) throw new Error('IPA version is missing');
  const bytes = await fs.readFile(ipaPath);
  const metadata = {
    name: info.CFBundleDisplayName || info.CFBundleName,
    version: String(info.CFBundleShortVersionString),
    build: String(info.CFBundleVersion),
    minimumOSVersion: info.MinimumOSVersion || null,
    bundleId: info.CFBundleIdentifier,
    sizeBytes: bytes.length,
    sha256: createHash('sha256').update(bytes).digest('hex'),
    url: '/shuguang.ipa',
  };
  const root = path.resolve(__dirname, '..');
  await fs.mkdir(outputDir, { recursive: true });
  await fs.copyFile(path.join(root, 'www/download.html'), path.join(outputDir, 'index.html'));
  await fs.copyFile(path.join(root, 'ios/App/App/Assets.xcassets/AppIcon.appiconset/AppIcon-512@2x.png'), path.join(outputDir, 'app-icon.png'));
  await fs.writeFile(path.join(outputDir, 'ipa.json'), JSON.stringify(metadata, null, 2) + '\n');
  return metadata;
}

if (require.main === module) {
  const [, , ipaPath, outputDir] = process.argv;
  if (!ipaPath) {
    console.error('Usage: npm run prepare:download -- <path/to/shuguang.ipa> [output-directory]');
    process.exitCode = 1;
  } else {
    prepareDownload(ipaPath, outputDir).then(metadata => console.log(JSON.stringify(metadata, null, 2)))
      .catch(error => { console.error(error.message); process.exitCode = 1; });
  }
}

module.exports = { prepareDownload, readArchive };
