// Offline protocol self-test. Kept separate from the node:test file so the
// CLI can run it without registering the whole test suite a second time.
const assert = require('node:assert/strict');
const { COMMAND, frame, encodeRows } = require('./k3-protocol.cjs');
const { K3Client } = require('./k3-serial.cjs');
const { FakeK3, FakeTransport } = require('./k3-fake-printer.cjs');

const blankRows = (width, height) => Buffer.alloc(Math.ceil(width / 8) * height);

async function selfTest() {
  const checks = [];
  const check = (name, fn) => {
    try { fn(); checks.push({ name, ok: true }); } catch (error) { checks.push({ name, ok: false, error: error.message }); }
  };
  check('connect frame', () => assert.equal(frame(0xc1, [1], { prefix: true }).toString('hex'), '035555c10101c1aaaa'));
  check('MSB-first row', () => {
    const payload = encodeRows(Buffer.from([0x81]), 8).packets[0].payload;
    assert.equal(payload[6], 0x81);
    assert.equal(payload[2], 2);
  });
  check('empty rows >255 split', () => assert.equal(encodeRows(blankRows(8, 600), 8).packets.length, 3));
  try {
    const printer = new FakeK3();
    const client = new K3Client(new FakeTransport(printer), { timeoutMs: 800 });
    const outcome = await client.print({ width: 80, height: 3, copies: 1, rowsBase64: blankRows(80, 3).toString('base64') });
    const order = printer.commands.map(item => item.command).filter(item => item !== COMMAND.PRINT_STATUS);
    checks.push({
      name: 'simulated V4 print completes', ok: outcome.status === 'printed',
      sequence: order.map(value => value.toString(16).padStart(2, '0')).join(' '),
      noPrintClear: !order.includes(COMMAND.PRINT_CLEAR),
    });
  } catch (error) {
    checks.push({ name: 'simulated V4 print completes', ok: false, error: error.message });
  }
  const failed = checks.filter(item => !item.ok);
  return { ok: failed.length === 0, checks, failed: failed.length };
}

module.exports = { selfTest };
