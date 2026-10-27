const test = require('node:test');
const assert = require('node:assert/strict');
process.env.TS_NODE_COMPILER_OPTIONS = JSON.stringify({ module: 'commonjs', target: 'es2020' });
require('ts-node/register/transpile-only');
const protocol = require('../src/services/bluetooth-630k-protocol.ts');

const id = 'remote-630k-test-0001';
const document = { key: 'delivery-1', number: 'SH-1', title: '送货单', party: '曙光', date: '2026-10-27', orderNumber: '', operator: '小李', lines: [] };
const settings = { template: 'delivery-note', formTitle: '出库单', paper: '241-93', width: 241, height: 93, company: '曙光', fontSize: 11, rowsPerPage: 5, offsetX: 0, offsetY: 0, showPrices: true, highClarity: true };
const validInfo = { v: 1, relayId: '8f0b5d8e-6b6d-42d9-9b80-5f3257a0f021', name: '630K', maxPayload: 524288, chunkSize: 180 };
const validStatus = { v: 1, id, status: 'queued', message: '已进入打印队列', updatedAt: 1790000000000 };

test('envelope uses UTF-8 bytes and supports Chinese content', () => {
  const bytes = protocol.encodeBle630KEnvelope({ id, document: { ...document, party: '东光县曙光纸箱包装' }, settings });
  assert.equal(new TextDecoder().decode(bytes), JSON.stringify({ v: 1, job: { id, document: { ...document, party: '东光县曙光纸箱包装' }, settings } }));
  assert.ok(bytes.length > JSON.stringify({ v: 1, job: { id, document: { ...document, party: '东光县曙光纸箱包装' }, settings } }).length);
});

test('SHA-256 matches standard empty and abc vectors in fallback and async implementations', async () => {
  const enc = value => new TextEncoder().encode(value);
  assert.equal(protocol.sha256HexFallback(enc('')), 'e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855');
  assert.equal(protocol.sha256HexFallback(enc('abc')), 'ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad');
  assert.equal(await protocol.sha256Hex(enc('abc')), 'ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad');
});

test('data frames use contiguous big-endian ordinals and payload chunks', () => {
  const input = Uint8Array.from({ length: 37 }, (_, index) => index);
  const frames = protocol.frameBle630KData(input, 16);
  assert.equal(frames.length, 3);
  assert.deepEqual(frames.map(frame => Array.from(frame.slice(0, 4))), [[0, 0, 0, 0], [0, 0, 0, 1], [0, 0, 0, 2]]);
  assert.deepEqual(frames.map(frame => frame.length - 4), [16, 16, 5]);
  assert.deepEqual(Buffer.concat(frames.map(frame => Buffer.from(frame.slice(4)))), Buffer.from(input));
});

test('control command frames fit MTU, use the 9-byte header, and reassemble UTF-8', () => {
  const command = JSON.stringify({ v: 1, op: 'status', id, name: '曙光' });
  const bytes = new TextEncoder().encode(command);
  const frames = protocol.frameBle630KControl(command, 0x1234, 23);
  assert.ok(frames.every(frame => frame.length <= 20));
  assert.equal(frames[0][0], 0xb6);
  assert.equal(new DataView(frames[0].buffer).getUint16(1, false), 0x1234);
  assert.equal(new DataView(frames[0].buffer).getUint16(3, false), bytes.length);
  assert.deepEqual(frames.map(frame => new DataView(frame.buffer).getUint16(5, false)), frames.map((_, index) => index * 11));
  assert.deepEqual(frames.map(frame => new DataView(frame.buffer).getUint16(7, false)), frames.map(frame => frame.length - 9));
  assert.deepEqual(Buffer.concat(frames.map(frame => Buffer.from(frame.slice(9)))), Buffer.from(bytes));
  assert.throws(() => protocol.frameBle630KControl('', 1, 23), /分帧参数/);
  assert.throws(() => protocol.frameBle630KControl('x', 65536, 23), /分帧参数/);
  assert.throws(() => protocol.frameBle630KControl('x', 1, 22), /分帧参数/);
  assert.throws(() => protocol.frameBle630KControl('x'.repeat(4097), 1, 517), /分帧参数/);
});

test('relay info rejects missing, unknown, oversized, and invalid fields', () => {
  assert.deepEqual(protocol.validateBle630KRelayInfo(validInfo), validInfo);
  assert.throws(() => protocol.validateBle630KRelayInfo({ ...validInfo, extra: 1 }), /打印电脑信息/);
  assert.throws(() => protocol.validateBle630KRelayInfo({ ...validInfo, maxPayload: 524289 }), /打印电脑信息/);
  assert.throws(() => protocol.validateBle630KRelayInfo({ ...validInfo, chunkSize: 181 }), /打印电脑信息/);
  assert.throws(() => protocol.validateBle630KRelayInfo({ ...validInfo, relayId: 'bad' }), /打印电脑信息/);
});

test('status accepts the relay JOB_NOT_FOUND shape and rejects malformed or mismatched replies', () => {
  assert.deepEqual(protocol.validateBle630KJob(validStatus, id), validStatus);
  assert.throws(() => protocol.validateBle630KJob({ ...validStatus, status: 'waiting' }), /打印状态/);
  assert.throws(() => protocol.validateBle630KJob({ ...validStatus, other: 'field' }), /打印状态/);
  assert.throws(() => protocol.validateBle630KJob({ ...validStatus, message: null }), /打印状态/);
  assert.throws(() => protocol.validateBle630KJob({ ...validStatus, id: 'remote-630k-test-0002' }, id), /其他任务/);
  const notFound = { v: 1, id, status: 'failed', code: 'JOB_NOT_FOUND', message: '原任务不存在', updatedAt: 1790000000000 };
  assert.throws(() => protocol.validateBle630KJob(notFound, id), error => error.code === 'JOB_NOT_FOUND' && error.jobId === id);
  assert.throws(() => protocol.validateBle630KJob({ ...notFound, status: 'unknown' }, id), /打印状态/);
  assert.throws(() => protocol.validateBle630KJob({ ...notFound, extra: true }, id), /打印状态/);
  assert.throws(() => protocol.validateBle630KJob({ ...notFound, id: 'remote-630k-test-0002' }, id), /其他任务/);
});

test('oversized, null-containing, and invalid-ID envelopes are rejected', () => {
  assert.throws(() => protocol.encodeBle630KEnvelope({ id, document: { ...document, party: 'x'.repeat(600000) }, settings }), /512 KiB/);
  assert.throws(() => protocol.encodeBle630KEnvelope({ id, document: { ...document, address: null }, settings }), /空值/);
  assert.throws(() => protocol.encodeBle630KEnvelope({ id: 'bad', document, settings }), /无效/);
  assert.throws(() => protocol.createBle630KBegin(id, 1, 'z'.repeat(64), '241-93'), /无效/);
});

test('existing statuses are returned and only safe failed jobs are retransmittable', () => {
  const states = ['received', 'processing', 'queued', 'uncertain'];
  for (const status of states) assert.equal(protocol.mayTransferBle630KJob({ ...validStatus, status }), false);
  assert.equal(protocol.mayTransferBle630KJob({ ...validStatus, status: 'failed' }), true);
  assert.equal(protocol.validateBle630KJob(validStatus, id).id, id);
});