const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { pairingToken, createPairCard } = require('../scripts/remote-print-pair-card.cjs');

const token = 'c'.repeat(64);

test('pair card accepts a raw token or a pairing link without exposing the token as text', async () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'remote-print-pair-card-'));
  try {
    assert.equal(pairingToken(token), token);
    assert.equal(pairingToken(`https://youxishen.online/#/pages/print-center/index?print_pair=${token}`), token);
    assert.equal(pairingToken('https://youxishen.online/?print_pair=invalid'), '');

    const output = await createPairCard(token, path.join(directory, 'pair.html'));
    const html = fs.readFileSync(output, 'utf8');
    assert.match(html, /手机扫码连接打印电脑/);
    assert.match(html, /data:image\/png;base64,/);
    assert.ok(!html.includes(token), 'raw pairing token must not be rendered as text');
    assert.deepEqual(fs.readdirSync(directory), ['pair.html']);
  } finally {
    fs.rmSync(directory, { recursive: true, force: true });
  }
});

test('pair card rejects malformed credentials without writing a file', async () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'remote-print-pair-card-invalid-'));
  try {
    await assert.rejects(createPairCard('bad', path.join(directory, 'pair.html')), /连接凭据无效/);
    assert.deepEqual(fs.readdirSync(directory), []);
  } finally {
    fs.rmSync(directory, { recursive: true, force: true });
  }
});
