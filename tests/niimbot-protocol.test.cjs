const test = require('node:test');
const assert = require('node:assert/strict');
const protocol = require('../prototypes/niimbot-protocol');

test('frames commands with XOR checksum and connect prefix', () => {
  assert.deepEqual(protocol.packet(0x40, [0x08]), [0x55, 0x55, 0x40, 0x01, 0x08, 0x49, 0xaa, 0xaa]);
  assert.deepEqual(protocol.connectPacket(), [0x03, 0x55, 0x55, 0xc1, 0x01, 0x01, 0xc1, 0xaa, 0xaa]);
});

test('parses fragmented and coalesced notifications without losing buffered bytes', () => {
  const first = protocol.packet(0x48, [0x13, 0x04]);
  const second = protocol.packet(0x4a, [0x04]);
  let result = protocol.parsePackets(first.slice(0, 5));
  assert.deepEqual(result.packets, []);
  result = protocol.parsePackets([...result.rest, ...first.slice(5), ...second]);
  assert.deepEqual(result.packets.map(packet => [packet.command, packet.data]), [[0x48, [0x13, 0x04]], [0x4a, [0x04]]]);
  assert.deepEqual(result.rest, []);
});

test('encodes the 70 mm raster row and K3 three-zone heater counts', () => {
  const row = new Array(70).fill(0);
  row[0] = 0x80;
  row[27] = 0xc0;
  row[54] = 0x01;
  const encoded = protocol.encodeRow(row, 7);
  assert.deepEqual(encoded.slice(0, 12), [0x55, 0x55, 0x85, 0x4c, 0x00, 0x07, 0x01, 0x02, 0x01, 0x01, 0x80, 0x00]);
  assert.equal(encoded.length, 70 + 13);
});

test('declares the K3 resolution and emits compact blank-row runs', () => {
  assert.deepEqual(protocol.K3_MODEL_IDS, [4864, 4865, 4868]);
  assert.equal(protocol.LABEL_WIDTH_PIXELS, 560);
  assert.equal(protocol.LABEL_HEIGHT_PIXELS, 800);
  assert.deepEqual(protocol.encodeEmptyRows(258, 255), [0x55, 0x55, 0x84, 0x03, 0x01, 0x02, 0xff, 0x7b, 0xaa, 0xaa]);
});

test('rejects malformed command and raster dimensions instead of wrapping bytes', () => {
  assert.throws(() => protocol.packet(1, new Array(256).fill(0)));
  assert.throws(() => protocol.packet(1, [-1]));
  assert.throws(() => protocol.packet(1, [256]));
  assert.throws(() => protocol.packet(1, [1.2]));
  assert.throws(() => protocol.encodeRow(new Array(83).fill(0), 0));
  assert.throws(() => protocol.encodeRow([0], -1));
});

test('decodes K3 IDs and print progress in documented byte order', () => {
  assert.equal(protocol.modelId([0x13]), 4864);
  assert.equal(protocol.modelId([0x13, 4]), 4868);
  assert.throws(() => protocol.modelId([]));
  assert.deepEqual(protocol.printStatus([0, 1, 100, 75]), { page: 1, printProgress: 100, feedProgress: 75 });
  assert.throws(() => protocol.printStatus([1]));
});

test('uses total-mode counters on the full 82-byte K3 print head', () => {
  const row = new Array(82).fill(255);
  assert.deepEqual(protocol.encodeRow(row, 0).slice(6, 9), [0, 0x90, 2]);
});

test('rejects corrupt frames and recovers the next valid notification', () => {
  const bad = protocol.packet(0x48, [19, 0]);
  bad[bad.length - 3] ^= 1;
  const parsed = protocol.parsePackets([0, 3, ...bad, ...protocol.packet(0xb3, [0, 1, 100, 100])]);
  assert.deepEqual(parsed.packets.map(frame => frame.command), [0xb3]);
});
