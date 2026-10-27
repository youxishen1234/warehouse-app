const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { printPayload, createJournal, createReceiver, createPrinterCoordinator } = require('../scripts/remote-print-agent.cjs');
const {
  validateBleEnvelope,
  createBleRelay,
} = require('../scripts/bluetooth-print-relay.cjs');

const job = () => ({
  id: 'ble-print-job-000001',
  lease: 'not-used-over-ble',
  printer: 'EPSON LQ-630K ESC/P2',
  paper: '241-93',
  note: {
    id: 11,
    number: 'SH-BLE-11',
    company: '东光县曙光纸箱包装',
    customer_name: '蓝牙测试客户',
    date: '2026-10-27',
    address: '河北省沧州市',
    phone: '13800000000',
    receiver: '王先生',
    sender: '张师傅',
    items: [{
      product_id: 3,
      name: '五层瓦楞纸箱',
      specification: '400×300×200',
      quantity: 12,
      price: 3.5,
      amount: 42,
      remark: '',
    }],
  },
});

function withTimeout(promise, label, timeoutMs = 3000) {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`${label} timed out after ${timeoutMs}ms`)), timeoutMs);
    promise.then(
      value => { clearTimeout(timer); resolve(value); },
      error => { clearTimeout(timer); reject(error); },
    );
  });
}

const envelope = (source = job()) => {
  const payload = printPayload(source);
  return {
    v: 1,
    job: {
      id: payload.id,
      document: payload.document,
      settings: payload.settings,
    },
  };
};

function relayRequest(endpoint, capability, route, options = {}) {
  return fetch(endpoint + route, {
    ...options,
    headers: {
      'Content-Type': 'application/json',
      'X-Warehouse-Ble-Relay': capability,
      ...(options.headers || {}),
    },
  });
}

test('BLE envelope validates the complete renderer input and rejects a phone-selected printer', () => {
  const validated = validateBleEnvelope(envelope(), 'EPSON LQ-630K ESC/P2');
  assert.equal(validated.id, job().id);
  assert.equal(validated.printerName, 'EPSON LQ-630K ESC/P2');
  assert.equal(validated.document.lines.length, 1);
  assert.equal(validated.settings.paper, '241-93');

  const injected = envelope();
  injected.job.printerName = 'attacker-selected-printer';
  assert.throws(() => validateBleEnvelope(injected, 'EPSON LQ-630K ESC/P2'), /不支持的字段/);
});

test('local BLE relay accepts once, prints once, and returns the durable result', async () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'ble-relay-'));
  const capability = 'b'.repeat(64);
  let printed = 0;
  try {
    const journal = createJournal(path.join(directory, 'jobs.json'));
    const relay = createBleRelay({
      journal,
      printerName: 'EPSON LQ-630K ESC/P2',
      capability,
      service: { submit: async input => { printed++; assert.equal(input.printerName, 'EPSON LQ-630K ESC/P2'); return { kind: 'queued' }; } },
    });
    const endpoint = await relay.start();
    const body = JSON.stringify(envelope());
    const first = await relayRequest(endpoint, capability, '/v1/jobs', { method: 'POST', body });
    assert.equal(first.status, 202);
    const accepted = await first.json();
    assert.equal(accepted.data.status, 'received');

    const second = await relayRequest(endpoint, capability, '/v1/jobs', { method: 'POST', body });
    assert.equal(second.status, 200);
    assert.equal((await second.json()).data.status, 'received');
    assert.equal(printed, 0, 'the HTTP path only persists before the single receiver loop processes it');

    const completed = await relay.tick();
    assert.equal(completed.status, 'queued');
    assert.equal(printed, 1);

    const duplicate = await relayRequest(endpoint, capability, '/v1/jobs', { method: 'POST', body });
    assert.equal(duplicate.status, 200);
    assert.equal((await duplicate.json()).data.status, 'queued');
    await relay.tick();
    assert.equal(printed, 1, 'a replayed job never reaches the printer twice');
    await relay.stop();
  } finally {
    fs.rmSync(directory, { recursive: true, force: true });
  }
});

test('receiver enumeration and spooler repair wait for a held BLE print', { timeout: 10000 }, async () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'ble-printer-coordination-'));
  const capability = 'a'.repeat(64);
  const withPrinter = createPrinterCoordinator();
  const events = [];
  let now = 0;
  let listCalls = 0;
  let relay;
  let printing;
  let receiving;
  let releasePrint;
  let markPrintStarted;
  const printStarted = new Promise(resolve => { markPrintStarted = resolve; });
  const heldPrint = new Promise(resolve => { releasePrint = resolve; });
  try {
    const journal = createJournal(path.join(directory, 'jobs.json'));
    const service = {
      submit: async () => {
        events.push('ble:begin');
        markPrintStarted();
        await heldPrint;
        events.push('ble:end');
        return { kind: 'queued' };
      },
      list: async () => {
        events.push('list:begin');
        listCalls++;
        if (listCalls <= 3) {
          events.push('list:error');
          throw new Error('enumeration unavailable');
        }
        events.push('list:end');
        return [{ name: '630K' }];
      },
      repair: async () => {
        events.push('repair:begin');
        events.push('repair:end');
        return { kind: 'spooler-repaired', repaired: true };
      },
    };
    const receiver = createReceiver({
      printerName: '630K',
      journal,
      service,
      withPrinter,
      now: () => now,
      call: async () => ({}),
      report: () => {},
    });
    await receiver.tick();
    now = 5001;
    await receiver.tick();
    assert.equal(listCalls, 2, 'two failures establish the bounded-repair threshold');

    const payload = validateBleEnvelope(envelope(), '630K');
    relay = createBleRelay({ journal, printerName: '630K', capability, service, withPrinter });
    await relay.start();
    journal.reserveBle(payload);
    printing = relay.tick();
    await withTimeout(printStarted, 'BLE print start');

    now = 10002;
    receiving = receiver.tick();
    await withTimeout(new Promise(resolve => setImmediate(resolve)), 'receiver scheduling');
    assert.deepEqual(events.slice(events.indexOf('ble:begin')), ['ble:begin']);
    assert.equal(listCalls, 2, 'enumeration waits behind the BLE print lock');
    assert.equal(events.includes('repair:begin'), false, 'repair cannot start while BLE owns the printer');

    releasePrint();
    assert.equal((await withTimeout(printing, 'BLE print completion')).status, 'queued');
    await withTimeout(receiving, 'network receiver completion');

    const afterPrint = events.slice(events.indexOf('ble:end') + 1);
    assert.deepEqual(afterPrint, ['list:begin', 'list:error', 'repair:begin', 'repair:end', 'list:begin', 'list:end']);
    assert.equal(listCalls, 4, 'the post-repair enumeration still runs and recovers');
    await relay.stop();
  } finally {
    releasePrint?.();
    await withTimeout(Promise.allSettled([printing, receiving].filter(Boolean)), 'test cleanup').catch(() => {});
    if (relay) await withTimeout(relay.stop(), 'relay shutdown').catch(() => {});
    fs.rmSync(directory, { recursive: true, force: true });
  }
});

test('local relay rejects callers without its process capability', async () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'ble-auth-'));
  try {
    const relay = createBleRelay({
      journal: createJournal(path.join(directory, 'jobs.json')),
      printerName: '630K',
      capability: 'c'.repeat(64),
      service: { submit: async () => ({ kind: 'queued' }) },
    });
    const endpoint = await relay.start();
    const response = await relayRequest(endpoint, 'd'.repeat(64), '/v1/health');
    assert.equal(response.status, 401);
    await relay.stop();
  } finally {
    fs.rmSync(directory, { recursive: true, force: true });
  }
});

test('failed BLE work can reuse its ID, while uncertain work blocks both transports until checked', async () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'ble-states-'));
  let calls = 0;
  try {
    const journal = createJournal(path.join(directory, 'jobs.json'));
    const payload = validateBleEnvelope(envelope(), '630K');
    const relay = createBleRelay({
      journal,
      printerName: '630K',
      capability: 'e'.repeat(64),
      service: {
        submit: async () => {
          calls++;
          if (calls === 1) throw Object.assign(new Error('renderer unavailable'), { safeToRetry: true });
          if (calls === 2) throw Object.assign(new Error('renderer stopped after print boundary'), { safeToRetry: false });
          return { kind: 'queued' };
        },
      },
    });
    await relay.start();
    journal.reserveBle(payload);
    assert.equal((await relay.tick()).status, 'failed');
    journal.reserveBle(payload);
    assert.equal((await relay.tick()).status, 'uncertain');
    assert.throws(() => journal.reserveBle({ ...payload, id: 'ble-print-job-000002' }), /尚未核对/);
    assert.equal(journal.nextBle(), null);

    const ready = [];
    const receiver = createReceiver({
      printerName: '630K',
      journal,
      service: { list: async () => [{ name: '630K' }], submit: async () => ({ kind: 'queued' }) },
      call: async (route, body) => {
        if (route === 'agent/poll') ready.push(body.ready);
        return { job: null };
      },
    });
    await receiver.tick();
    assert.deepEqual(ready, [false], 'an unresolved BLE paper outcome blocks HTTPS claims too');

    assert.equal(journal.resolveBle(payload.id, 'missing').status, 'failed');
    journal.reserveBle({ ...payload, id: 'ble-print-job-000002' });
    assert.equal((await relay.tick()).status, 'queued');
    await relay.stop();
  } finally {
    fs.rmSync(directory, { recursive: true, force: true });
  }
});

test('a receiver crash after BLE processing starts reopens the job as uncertain, never safe-to-retry', () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'ble-crash-'));
  const file = path.join(directory, 'jobs.json');
  try {
    const first = createJournal(file);
    const payload = validateBleEnvelope(envelope(), '630K');
    first.reserveBle(payload);
    first.startBle(payload.id);
    const restarted = createJournal(file);
    const recovered = restarted.bleStatus(payload.id);
    assert.equal(recovered.status, 'uncertain');
    assert.equal(recovered.payload, undefined);
    assert.equal(restarted.nextBle(), null);
  } finally {
    fs.rmSync(directory, { recursive: true, force: true });
  }
});

test('journal write failures stop both transports before any renderer work', async () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'ble-disk-failure-'));
  const file = path.join(directory, 'jobs.json');
  let printed = 0;
  try {
    const journal = createJournal(file);
    fs.mkdirSync(file);
    const payload = validateBleEnvelope(envelope(), '630K');
    assert.throws(() => journal.reserveBle(payload), error => error.code === 'JOURNAL_UNAVAILABLE');
    assert.equal(journal.hasUncertain(), true);
    assert.equal(journal.nextBle(), null);
    assert.throws(() => journal.bleStatus(payload.id), /保存失败/);
    const relay = createBleRelay({ journal, printerName: '630K', capability: 'f'.repeat(64), service: { submit: async () => { printed++; return { kind: 'queued' }; } } });
    await relay.tick();
    assert.equal(printed, 0, 'an in-memory reservation must never print after durable storage failed');
    await relay.stop();
  } finally {
    fs.rmSync(directory, { recursive: true, force: true });
  }
});

test('queued paper confirmation advances the receipt timestamp without printing again', () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'ble-confirm-'));
  try {
    const journal = createJournal(path.join(directory, 'jobs.json'));
    const payload = validateBleEnvelope(envelope(), '630K');
    journal.reserveBle(payload);
    journal.startBle(payload.id);
    const previous = journal.finishBle(payload.id, { status: 'queued' }).updatedAt;
    const confirmed = journal.resolveBle(payload.id, 'printed');
    assert.equal(confirmed.status, 'queued');
    assert.ok(confirmed.updatedAt > previous);
    assert.ok(confirmed.confirmedPrintedAt > 0);
    assert.equal(journal.nextBle(), null);
    assert.throws(() => journal.resolveBle(payload.id, 'missing'), /只有结果未确认/);
  } finally {
    fs.rmSync(directory, { recursive: true, force: true });
  }
});
