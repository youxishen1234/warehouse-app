const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const root = path.resolve(__dirname, '..');
const fontDirectory = path.join(root, 'src', 'assets', 'label-fonts');
const subsetFonts = [
  'SourceHanSansSC-Heavy.gb2312-l1.woff2',
  'SourceHanSansSC-Medium.gb2312-l1.woff2'
];

test('remote label printing uses compact WOFF2 fonts with a system fallback', () => {
  let totalBytes = 0;
  for (const filename of subsetFonts) {
    const file = path.join(fontDirectory, filename);
    const bytes = fs.readFileSync(file);
    assert.equal(bytes.subarray(0, 4).toString('ascii'), 'wOF2', `${filename} must be WOFF2`);
    assert(bytes.length < 1_500_000, `${filename} unexpectedly grew to ${bytes.length} bytes`);
    totalBytes += bytes.length;
  }
  assert(totalBytes < 3 * 1024 * 1024, `label font subsets total ${totalBytes} bytes`);

  const remoteLayout = fs.readFileSync(path.join(root, 'src', 'features', 'label-print', 'remote-layout.ts'), 'utf8');
  const k3Layout = fs.readFileSync(path.join(root, 'scripts', 'k3-layout.cjs'), 'utf8');
  for (const source of [remoteLayout, k3Layout]) {
    assert.match(source, /SourceHanSansSC-Heavy\.gb2312-l1\.woff2/);
    assert.match(source, /SourceHanSansSC-Medium\.gb2312-l1\.woff2/);
    assert.doesNotMatch(source, /label-fonts\/SourceHanSansSC-(?:Heavy|Medium)\.woff2/);
    assert.match(source, /PaperboardSourceHan,"Microsoft YaHei","PingFang SC",sans-serif/);
  }
});
