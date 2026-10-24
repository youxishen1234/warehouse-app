const test = require('node:test');
const assert = require('node:assert/strict');
const {
  COMMAND, FrameParser, bcc, frame, encodeRows, popcount, parseStatus, parseHeartbeat, errorName,
} = require('./k3-protocol.cjs');
const { K3Client, K3Error, BridgeTransport } = require('./k3-serial.cjs');
const { FakeK3, FakeTransport } = require('./k3-fake-printer.cjs');

const blankRows = (width, height) => Buffer.alloc(Math.ceil(width / 8) * height);

test('frame encodes the documented connect packet exactly', () => {
  const packet = frame(COMMAND.CONNECT, [0x01], { prefix: true });
  assert.equal(packet.toString('hex'), '035555c10101c1aaaa');
  assert.equal(bcc(0xc1, Buffer.from([1])), 0xc1);
});

test('info request frame matches known printer bytes', () => {
  assert.equal(frame(COMMAND.PRINTER_INFO, [8]).toString('hex'), '555540010849aaaa');
});

test('parser reassembles a frame split at every byte boundary', () => {
  const packet = frame(0xb5, [1, 2, 3, 4]);
  for (let cut = 1; cut < packet.length; cut += 1) {
    const parser = new FrameParser();
    assert.deepEqual(parser.push(packet.subarray(0, cut)), []);
    const frames = parser.push(packet.subarray(cut));
    assert.equal(frames.length, 1);
    assert.equal(frames[0].command, 0xb5);
    assert.equal(frames[0].payload.toString('hex'), '01020304');
  }
});

test('parser handles several frames in one read plus leading garbage', () => {
  const parser = new FrameParser();
  const input = Buffer.concat([
    Buffer.from([0x00, 0x13, 0x55]),
    frame(0xc2, [3]),
    frame(0xe0, [0, 1]),
    frame(0xb3, [0, 2, 100, 100]),
  ]);
  const frames = parser.push(input);
  assert.deepEqual(frames.map(item => item.command), [0xc2, 0xe0, 0xb3]);
});

test('parser rejects a bad checksum without losing the next good frame', () => {
  const bad = Buffer.from(frame(0xc2, [3]));
  bad[bad.length - 3] ^= 0xff;
  const parser = new FrameParser();
  const frames = parser.push(Buffer.concat([bad, frame(0x49, [5, 7])]));
  assert.equal(frames.length, 1);
  assert.equal(frames[0].command, 0x49);
});

test('parser drops a frame with a broken tail', () => {
  const bad = Buffer.from(frame(0x49, [5, 7]));
  bad[bad.length - 1] = 0x00;
  const parser = new FrameParser();
  assert.deepEqual(parser.push(bad), []);
});

test('row encoding is MSB-first with 1 meaning black', () => {
  const rows = Buffer.from([0b10000001, 0b00000011]);
  const { packets } = encodeRows(rows, 16);
  assert.equal(packets.length, 1);
  assert.equal(packets[0].payload.subarray(6).toString('hex'), '8103');
  assert.equal(packets[0].payload.readUInt16BE(0), 0);
  assert.equal(packets[0].payload[5], 1, 'repeats');
});

test('counters split the row into three 27-byte chunks', () => {
  const width = 656;
  const rowBytes = Math.ceil(width / 8);
  const row = Buffer.alloc(rowBytes);
  const chunk = Math.floor(656 / 8 / 3);
  row[0] = 0xff;                 // first chunk: 8 black pixels
  row[chunk] = 0x0f;             // second chunk: 4
  row[chunk * 2] = 0x03;         // third chunk: 2
  row[rowBytes - 1] = 0x80;      // last chunk: 1 more
  const { packets } = encodeRows(row, width);
  const payload = packets[0].payload;
  assert.equal(payload.length, 6 + rowBytes);
  assert.deepEqual([payload[2], payload[3], payload[4]], [8, 4, 3]);
  assert.equal(popcount(0b10101010), 4);
});

test('consecutive blank rows collapse into 0x84 packets of at most 255 rows', () => {
  const width = 80;
  const rows = blankRows(width, 600);
  const { packets } = encodeRows(rows, width);
  assert.deepEqual(packets.map(item => [item.type, item.row, item.count]), [
    ['empty', 0, 255], ['empty', 255, 255], ['empty', 510, 90],
  ]);
  for (const packet of packets) assert.ok(packet.payload[2] <= 255);
});

test('encodeRows rejects a bitmap that is not a whole number of rows', () => {
  assert.throws(() => encodeRows(Buffer.alloc(5), 16), /whole number/);
  assert.throws(() => encodeRows(Buffer.alloc(2), 664), /out of range/);
});

test('parseStatus reads page, progress and feed progress only', () => {
  // Byte 6 is firmware metadata on real K3 units (0x08 while idle), not an
  // error flag. Treating it as an error reported a phantom paper-feed fault.
  const status = parseStatus(Buffer.from([0, 3, 100, 100, 0, 0, 2, 0, 0, 0]));
  assert.deepEqual(status, { page: 3, progress: 100, feedProgress: 100 });
});

test('parseHeartbeat decodes lid/paper polarity from Advanced2', () => {
  const beat = parseHeartbeat(Buffer.from([0, 0, 4, 24, 0, 0, 1, 0, 0, 0, 0, 0, 0, 2]));
  assert.equal(beat.battery, 4);
  assert.equal(beat.lidOpen, false);
  assert.equal(beat.paperPresent, true);
  assert.equal(beat.paperRfid, true);
  assert.equal(beat.ribbonPresent, true);
});

test('error codes map to Chinese operator messages', () => {
  assert.equal(errorName(1), '上盖未关闭');
  assert.equal(errorName(2), '标签纸已用完');
  assert.match(errorName(0x99), /0x99/);
});

async function printOnce(options = {}) {
  const printer = new FakeK3(options.printer);
  const client = new K3Client(new FakeTransport(printer, options.transport), {
    timeoutMs: 1000, printTimeoutMs: options.printTimeoutMs || 90000,
  });
  const width = options.width || 80, height = options.height || 4;
  const result = await client.print({
    width, height, copies: options.copies ?? 1,
    rowsBase64: options.rows ? options.rows.toString('base64') : blankRows(width, height).toString('base64'),
  });
  return { printer, result, client };
}

test('V4 print sequence is sent in the documented order', async () => {
  const { printer, result } = await printOnce();
  assert.equal(result.status, 'printed');
  // Status polls may be interleaved anywhere; the write sequence itself must not drift.
  const order = printer.commands.map(item => item.command).filter(item => item !== COMMAND.PRINT_STATUS);
  const expected = [
    COMMAND.CONNECT, COMMAND.PRINTER_INFO,
    COMMAND.SET_DENSITY, COMMAND.SET_LABEL_TYPE, COMMAND.PRINT_START,
    COMMAND.PAGE_START, COMMAND.SET_PAGE_SIZE, COMMAND.PRINT_EMPTY_ROW,
    COMMAND.PRINT_CHECK_LINE, COMMAND.PAGE_END, COMMAND.PRINT_END,
  ];
  assert.deepEqual(order.slice(0, expected.length), expected);
  assert.ok(!order.includes(COMMAND.PRINT_CLEAR), 'PrintClear must never be sent to K3');
});

test('PrintStart carries the 7-byte B1 layout used by K3 firmware', async () => {
  const { printer } = await printOnce();
  const start = printer.commands.find(item => item.command === COMMAND.PRINT_START);
  assert.equal(start.payload, '00010000000000');
});

test('three-copy job sends matching page size and confirms three pages', async () => {
  const printer = new FakeK3({ emitPageEvent: false, pageMode: 'job' });
  const transport = new FakeTransport(printer);
  const write = transport.write.bind(transport);
  transport.write = async packet => {
    const response = await write(packet);
    if (packet[2] === COMMAND.PAGE_END) return Buffer.concat([response, frame(0xe0, [0, 3])]);
    if (packet[2] === COMMAND.PRINT_STATUS && printer.finished) {
      return frame(0xb3, [0, 3, 100, 100, 0, 0, 0, 0, 0, 0]);
    }
    return response;
  };
  const client = new K3Client(transport, { timeoutMs: 500 });
  const result = await client.print({
    width: 80, height: 4, copies: 3,
    rowsBase64: blankRows(80, 4).toString('base64'),
  });
  const start = printer.commands.find(item => item.command === COMMAND.PRINT_START);
  const size = printer.commands.find(item => item.command === COMMAND.SET_PAGE_SIZE);
  assert.equal(Buffer.from(start.payload, 'hex').readUInt16BE(0), 3);
  assert.equal(Buffer.from(size.payload, 'hex').readUInt16BE(4), 3);
  assert.equal(result.status, 'printed');
  assert.equal(result.pages, 3);
  assert.equal(result.pageAfter, 3);
});

test('first cumulative page event does not complete a three-copy job', async () => {
  const { printer, result } = await printOnce({
    copies: 3,
    printTimeoutMs: 350,
    printer: { pagesBefore: 5, emitPageEvent: true, pageMode: 'increment' },
  });
  assert.equal(printer.page, 6, 'simulated printer has reported only the first cumulative page');
  assert.equal(result.status, 'uncertain');
  assert.equal(result.pages, 0);
});

test('cumulative page count confirms all copies only at baseline plus requested count', async () => {
  const printer = new FakeK3({ pagesBefore: 5, emitPageEvent: false, pageMode: 'increment' });
  const transport = new FakeTransport(printer);
  const write = transport.write.bind(transport);
  transport.write = async packet => {
    const response = await write(packet);
    if (packet[2] === COMMAND.PAGE_END) printer.page = 8;
    return response;
  };
  const client = new K3Client(transport, { timeoutMs: 500 });
  const result = await client.print({
    width: 80, height: 4, copies: 3, rowsBase64: blankRows(80, 4).toString('base64'),
  });
  assert.equal(result.status, 'printed');
  assert.equal(result.pages, 3);
  assert.equal(result.pageAfter, 8);
});

test('reset counter at page zero with 100 percent is not a completed copy', async () => {
  const printer = new FakeK3({ pagesBefore: 2, emitPageEvent: false, pageMode: 'increment' });
  const originalStatusPayload = printer.statusPayload.bind(printer);
  printer.statusPayload = function resetCounterAfterPageEnd() {
    if (this.pageEndedAt) return [0, 0, 100, 100, 0, 0, 0, 0, 0, 0];
    return originalStatusPayload();
  };
  const client = new K3Client(new FakeTransport(printer), { timeoutMs: 500, printTimeoutMs: 350 });
  const result = await client.print({
    width: 80, height: 2, copies: 1, rowsBase64: blankRows(80, 2).toString('base64'),
  });
  assert.equal(result.status, 'uncertain');
  assert.equal(result.pageAfter, 0);
});

test('copy count must be an integer from one through ninety-nine', async () => {
  const printer = new FakeK3();
  const client = new K3Client(new FakeTransport(printer));
  await assert.rejects(client.print({
    width: 80, height: 2, copies: 100, rowsBase64: blankRows(80, 2).toString('base64'),
  }), error => error instanceof K3Error && error.code === 'INVALID_COPIES');
  assert.equal(printer.commands.length, 0);
});

test('speed is not encoded in the K3 PrintStart payload', async () => {
  const printer = new FakeK3();
  const client = new K3Client(new FakeTransport(printer), { timeoutMs: 1000 });
  await client.print({
    width: 80, height: 2, copies: 1, speed: 9,
    rowsBase64: blankRows(80, 2).toString('base64'),
  });
  const start = printer.commands.find(item => item.command === COMMAND.PRINT_START);
  assert.equal(start.payload, '00010000000000');
});

test('printed is reported when firmware leaves feedProgress at zero', async () => {
  const { result } = await printOnce({
    printer: { emitPageEvent: true, feedProgressOnComplete: 0 },
  });
  assert.equal(result.status, 'printed');
  assert.equal(result.pages, 1);
});

test('a rejected PrintStart is a retryable setup error, not an uncertain job', async () => {
  const printer = new FakeK3({ failWith: { at: COMMAND.PRINT_START, code: 0x08 } });
  const transport = new FakeTransport(printer);
  const client = new K3Client(transport, { timeoutMs: 500 });
  await assert.rejects(client.print({
    width: 80, height: 2, copies: 1, rowsBase64: blankRows(80, 2).toString('base64'),
  }), error => error instanceof K3Error && error.retryable === true && /未开始打印/.test(error.message));
  assert.equal(printer.commands.filter(item => item.command === COMMAND.PAGE_START).length, 0);
  assert.equal(printer.commands.filter(item => item.command === COMMAND.CANCEL_PRINT).length, 1);
  assert.equal(printer.commands.filter(item => item.command === COMMAND.PRINT_END).length, 1);
});

test('a dropped PrintStart acknowledgement is uncertain and closes the possible session once', async () => {
  const printer = new FakeK3();
  const transport = new FakeTransport(printer);
  const write = transport.write.bind(transport);
  transport.write = async packet => {
    const response = await write(packet);
    return packet[2] === COMMAND.PRINT_START ? Buffer.alloc(0) : response;
  };
  const client = new K3Client(transport, { timeoutMs: 400 });
  const result = await client.print({
    width: 80, height: 2, copies: 1, rowsBase64: blankRows(80, 2).toString('base64'),
  });
  const commands = printer.commands.map(item => item.command);
  assert.equal(result.status, 'uncertain');
  assert.doesNotMatch(result.message, /未开始打印/);
  assert.equal(printer.started, true, 'simulated printer accepted PrintStart despite the lost reply');
  assert.equal(commands.filter(command => command === COMMAND.PRINT_START).length, 1);
  assert.equal(commands.filter(command => command === COMMAND.PAGE_START).length, 0);
  assert.equal(commands.filter(command => command === COMMAND.CANCEL_PRINT).length, 1);
  assert.equal(commands.filter(command => command === COMMAND.PRINT_END).length, 1);
});

test('an unconfirmed page ends the print session without resending the job', async () => {
  const { printer, result } = await printOnce({
    printer: { emitPageEvent: true, confirmPrintEnd: false },
    printTimeoutMs: 1200,
  });
  assert.equal(result.status, 'uncertain');
  const commands = printer.commands.map(item => item.command);
  assert.equal(commands.filter(item => item === COMMAND.PRINT_START).length, 1);
  assert.ok(commands.includes(COMMAND.CANCEL_PRINT), 'cancel must be attempted');
  assert.ok(commands.lastIndexOf(COMMAND.PRINT_END) > commands.indexOf(COMMAND.PAGE_END));
});

test('a timeout also closes the open print session once', async () => {
  const printer = new FakeK3({ emitPageEvent: false });
  printer.statusPayload = function stalled() {
    return [0, 2, 100, 100, 0, 0, 0, 0, 0, 0];
  };
  const client = new K3Client(new FakeTransport(printer), { printTimeoutMs: 800 });
  const result = await client.print({
    width: 80, height: 2, copies: 1, rowsBase64: blankRows(80, 2).toString('base64'),
  });
  assert.equal(result.status, 'uncertain');
  const commands = printer.commands.map(item => item.command);
  assert.equal(commands.filter(item => item === COMMAND.PRINT_START).length, 1);
  assert.ok(commands.includes(COMMAND.CANCEL_PRINT));
  assert.ok(commands.lastIndexOf(COMMAND.PRINT_END) > commands.indexOf(COMMAND.PAGE_END));
});

test('SetPageSize carries height, width and one copy', async () => {
  const { printer } = await printOnce({ width: 560, height: 3 });
  const size = printer.commands.find(item => item.command === COMMAND.SET_PAGE_SIZE);
  assert.equal(size.payload, '000302300001');
});

test('a stale 100% immediately after PageEnd never completes a job', async () => {
  const printer = new FakeK3({ emitPageEvent: false });
  const client = new K3Client(new FakeTransport(printer), { printTimeoutMs: 1500 });
  // The page counter still moves in this simulator, so use a printer that keeps
  // reporting the old page with 100% to model the real stale-status trap.
  printer.finished = false;
  const original = printer.statusPayload.bind(printer);
  printer.statusPayload = function stalled() {
    if (this.pageEndedAt) return [0, 2, 100, 100, 0, 0, 0, 0, 0, 0];
    return original();
  };
  const started = Date.now();
  const result = await client.print({
    width: 80, height: 2, copies: 1, rowsBase64: blankRows(80, 2).toString('base64'),
  });
  // With no fresh evidence, the sender must not report printed.
  assert.equal(result.status, 'uncertain');
  assert.ok(Date.now() - started < 10000);
});

test('page-bound event 0xE0 completes the job', async () => {
  const { result } = await printOnce({ printer: { emitPageEvent: true } });
  assert.equal(result.status, 'printed');
});

test('a job-complete page event works when the printer restarts page numbering', async () => {
  const { result, printer } = await printOnce({ printer: { emitPageEvent: true, pageMode: 'job' } });
  assert.equal(result.status, 'printed');
  assert.equal(printer.page, 1);
  assert.equal(result.pageBefore, 2);
  assert.equal(result.pageAfter, 1);
});

test('a job-complete page event works when the page counter keeps increasing', async () => {
  const { result, printer } = await printOnce({ printer: { emitPageEvent: true, pageMode: 'increment' } });
  assert.equal(result.status, 'printed');
  assert.equal(printer.page, 3);
  assert.equal(result.pageAfter, 3);
});

test('page polling completes without relying on the previous session page count', async () => {
  const { result } = await printOnce({ printer: { emitPageEvent: false, pageMode: 'job' } });
  assert.equal(result.status, 'printed');
  assert.equal(result.pageAfter, 1);
});

test('per-job page count of one completes only after fresh progress activity', async () => {
  const client = new K3Client({}, { printTimeoutMs: 2000 });
  const statuses = [
    { page: 1, progress: 40, feedProgress: 0 },
    { page: 1, progress: 100, feedProgress: 0 },
  ];
  client.printStatus = async () => statuses.shift();
  const completion = await client.waitComplete({
    totalPages: 1, baseline: { page: 1, progress: 100 }, deadline: Date.now() + 2000,
  });
  assert.equal(completion.method, 'poll');
  assert.deepEqual(completion.status, { page: 1, progress: 100, feedProgress: 0 });
});

test('constant stale page one at 100 percent does not complete a per-job counter', async () => {
  const client = new K3Client({}, { printTimeoutMs: 350 });
  client.printStatus = async () => ({ page: 1, progress: 100, feedProgress: 100 });
  const completion = await client.waitComplete({
    totalPages: 1, baseline: { page: 1, progress: 100 }, deadline: Date.now() + 350,
  });
  assert.equal(completion.method, 'timeout');
  assert.deepEqual(completion.status, { page: 1, progress: 100, feedProgress: 100 });
});

test('a coalesced hardware error and valid acknowledgement never reports printed', async () => {
  const printer = new FakeK3({ emitPageEvent: true });
  const transport = new FakeTransport(printer);
  const write = transport.write.bind(transport);
  transport.write = async packet => {
    const response = await write(packet);
    return packet[2] === COMMAND.PAGE_END
      ? Buffer.concat([frame(0xdb, [0x08]), response])
      : response;
  };
  const client = new K3Client(transport, { timeoutMs: 500, printTimeoutMs: 1000 });
  const result = await client.print({
    width: 80, height: 2, copies: 1, rowsBase64: blankRows(80, 2).toString('base64'),
  });
  assert.equal(result.status, 'uncertain');
  assert.match(result.message, /走纸异常/);
  assert.equal(printer.commands.filter(item => item.command === COMMAND.PRINT_START).length, 1);
  assert.equal(printer.commands.filter(item => item.command === COMMAND.CANCEL_PRINT).length, 1);
});

test('send preserves an unrelated event and reassembles a fragmented ack without rewriting', async () => {
  const acknowledgement = frame(0x31, [3]);
  const calls = { writes: 0, reads: 0, readTimeouts: [] };
  const transport = {
    async write() {
      calls.writes += 1;
      return Buffer.concat([frame(0xe0, [0, 1]), acknowledgement.subarray(0, 5)]);
    },
    async read(timeoutMs) {
      calls.reads += 1;
      calls.readTimeouts.push(timeoutMs);
      return acknowledgement.subarray(5);
    },
  };
  const client = new K3Client(transport, { timeoutMs: 1000 });
  const response = await client.send(COMMAND.SET_DENSITY, [3], { expect: 0x31 });
  assert.equal(response.command, 0x31);
  assert.deepEqual(client.events.map(item => item.command), [0xe0]);
  assert.equal(calls.writes, 1);
  assert.equal(calls.reads, 1);
  assert.ok(calls.readTimeouts[0] > 0 && calls.readTimeouts[0] <= 1000);
});

test('BridgeTransport.read uses the serial bridge read operation', async () => {
  const received = frame(0x31, [3]);
  const requests = [];
  const transport = new BridgeTransport({
    async request(message) {
      requests.push(message);
      return { ok: true, data: received.toString('base64') };
    },
  });
  assert.deepEqual(await transport.read(37), received);
  assert.deepEqual(requests, [{ op: 'read', timeoutMs: 37 }]);
});

test('print clears page events left over from earlier work', async () => {
  const printer = new FakeK3({ emitPageEvent: false, pageMode: 'job' });
  const client = new K3Client(new FakeTransport(printer), { timeoutMs: 500 });
  const stale = { command: 0xe0, payload: Buffer.from([0, 1]) };
  client.events.push(stale);
  const result = await client.print({
    width: 80, height: 2, copies: 1, rowsBase64: blankRows(80, 2).toString('base64'),
  });
  assert.equal(result.status, 'printed');
  assert.ok(!client.events.includes(stale));
});

test('PrintEnd must be confirmed before a page event becomes printed', async () => {
  const { result } = await printOnce({
    printer: { emitPageEvent: true, confirmPrintEnd: false },
    printTimeoutMs: 1500,
  });
  assert.equal(result.status, 'uncertain');
  assert.match(result.message, /结束回执未确认/);
});

test('a printer error during setup is reported as retryable and not printed', async () => {
  const printer = new FakeK3({ failWith: { at: COMMAND.SET_DENSITY, code: 0x01 } });
  const client = new K3Client(new FakeTransport(printer), { timeoutMs: 500 });
  await assert.rejects(client.print({
    width: 80, height: 2, copies: 1, rowsBase64: blankRows(80, 2).toString('base64'),
  }), error => error instanceof K3Error && /上盖未关闭/.test(error.message) && error.retryable === true);
});

test('a dropped response after PrintStart yields uncertain, never a retry', async () => {
  const printer = new FakeK3();
  const transport = new FakeTransport(printer, { dropFirst: 0 });
  const client = new K3Client(transport, { timeoutMs: 400 });
  await client.connect();
  await client.model();
  // Let setup work, then swallow the PageEnd acknowledgement.
  const write = transport.write.bind(transport);
  transport.write = async packet => {
    if (packet[2] === COMMAND.PAGE_END) return Buffer.alloc(0);
    return write(packet);
  };
  const result = await client.print({
    width: 80, height: 2, copies: 1, rowsBase64: blankRows(80, 2).toString('base64'),
  });
  assert.equal(result.status, 'uncertain');
  assert.match(result.message, /勿自动重发|检查实际出纸/);
});

test('rows are batched but every row keeps its absolute index', async () => {
  const rows = Buffer.alloc(2 * 10);
  rows[0] = 0x80; rows[10] = 0x40;
  const { printer } = await printOnce({ width: 80, height: 2, rows });
  assert.equal(printer.rows.length, 2);
  assert.equal(Buffer.from(printer.rows[0], 'hex').readUInt16BE(0), 0);
  assert.equal(Buffer.from(printer.rows[1], 'hex').readUInt16BE(0), 1);
});

test('800-row job checks completion at rows 199, 399, 599, and 799', async () => {
  const { printer } = await printOnce({ height: 800 });
  assert.deepEqual(
    printer.checks.map(hex => Buffer.from(hex, 'hex').readUInt16BE(0)),
    [199, 399, 599, 799],
  );
});

test('waitComplete propagates a hardware fault instead of turning it into a timeout', async () => {
  const client = new K3Client({}, { printTimeoutMs: 500 });
  client.printStatus = async () => { throw new K3Error('打印机报错：走纸异常', { code: 'PRINTER_ERROR' }); };
  await assert.rejects(client.waitComplete({
    totalPages: 1, baseline: { page: 1, progress: 100 }, deadline: Date.now() + 500,
  }), error => error instanceof K3Error && error.code === 'PRINTER_ERROR');
});

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
  let outcome;
  try {
    const printer = new FakeK3();
    const client = new K3Client(new FakeTransport(printer), { timeoutMs: 800 });
    outcome = await client.print({ width: 80, height: 3, copies: 1, rowsBase64: blankRows(80, 3).toString('base64') });
  } catch (error) { outcome = { status: 'error', message: error.message }; }
  checks.push({ name: 'simulated V4 print completes', ok: outcome.status === 'printed', result: outcome });
  const failed = checks.filter(item => !item.ok);
  return { ok: failed.length === 0, checks, failed: failed.length };
}

module.exports = { selfTest };

if (require.main === module) {
  test.run ? null : null;
}
