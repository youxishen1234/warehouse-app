const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const {
  signatureOf, createJournal, createAgent, validBitmap
} = require('../scripts/k3-remote-agent.cjs');

const mkdir = () => fs.mkdtempSync(path.join(os.tmpdir(), 'k3-agent-'));
const job = (overrides = {}) => ({
  id: 'label-test-job-0001', lease: 'lease-1', kind: 'finished-product', copies: 1,
  printer: 'K3-I911020404',
  profile: {
    profileId: 'p1', printerName: 'K3-I911020404', widthMm: 70, heightMm: 100,
    paperStyle: 'gap', density: 3,
    marginMm: { top: 0.6, right: 0.5, bottom: 0.5, left: 0.5 }, calibrated: true
  },
  data: { productId: 12, name: '成品 A' },
  ...overrides
});
const rendered = () => ({
  width: 560, height: 800,
  rowsBase64: Buffer.alloc(Math.ceil(560 / 8) * 800, 0x80).toString('base64'),
  pngPath: '', warnings: [], blackPixels: 20000, pixelRatio: 0.05
});

function harness({ printResult = { status: 'printed', pageBefore: 2, pageAfter: 3, pages: 1 }, renderResult = rendered(), jobs = [], readyProbe = async () => true } = {}) {
  const dir = mkdir();
  const journalFile = path.join(dir, 'k3-jobs.json');
  const journal = createJournal(journalFile);
  const calls = [];
  const prints = [];
  let first = true;
  const call = async (url, body) => {
    calls.push({ url, body });
    if (url === 'agent/poll') {
      if (first && body.ready) { first = false; return { job: jobs.shift() || null }; }
      return { job: null };
    }
    return { id: url.split('/').at(-1), status: body.status };
  };
  return {
    dir, journal, journalFile, calls, prints,
    agent: createAgent({
      config: { printer: 'K3-I911020404', port: 'COM3' }, journal,
      client: { print: async input => { prints.push(input); return printResult; } },
      render: async () => (typeof renderResult === 'function' ? renderResult() : renderResult),
      call, outputDir: dir, log: () => {}, readyProbe
    })
  };
}

test('printed serial outcome becomes queued with page evidence and is acknowledged', async () => {
  const h = harness({ jobs: [job()] });
  try {
    await h.agent.tick();
    const receipt = h.calls.find(item => item.url.startsWith('agent/jobs/'));
    assert.equal(receipt.body.status, 'queued');
    assert.match(receipt.body.message, /K3 已确认出纸（页 2 → 3）/);
    assert.equal(h.prints.length, 1);
    assert.ok(h.journal.get(job().id).acknowledged);
  } finally { fs.rmSync(h.dir, { recursive: true, force: true }); }
});

test('a finished label re-probes readiness before accepting the next label', async () => {
  let probes = 0;
  const h = harness({
    jobs: [job({ id: 'label-test-job-0003' })],
    readyProbe: async () => { probes += 1; return true; }
  });
  try {
    await h.agent.tick();
    assert.equal(probes, 1);
    await h.agent.tick();
    assert.equal(probes, 2, 'the next cycle probes instead of waiting twenty seconds');
    assert.equal(h.prints.length, 1);
  } finally { fs.rmSync(h.dir, { recursive: true, force: true }); }
});

test('uncertain serial outcome is never retried or converted to success', async () => {
  const h = harness({
    printResult: { status: 'uncertain', message: '打印机没有在 90 秒内确认出纸；请检查实机，勿自动重发' },
    jobs: [job()]
  });
  try {
    await h.agent.tick();
    const receipt = h.calls.find(item => item.url.startsWith('agent/jobs/'));
    assert.equal(receipt.body.status, 'uncertain');
    assert.match(receipt.body.message, /勿自动重发/);
    await h.agent.tick();
    assert.equal(h.prints.length, 1, 'an uncertain job is not printed again');
  } finally { fs.rmSync(h.dir, { recursive: true, force: true }); }
});

test('render warnings and an almost blank bitmap stop before the serial printer', async () => {
  const warn = harness({ renderResult: { ...rendered(), warnings: ['内容溢出'] }, jobs: [job()] });
  try {
    await warn.agent.tick();
    assert.equal(warn.prints.length, 0);
    assert.equal(warn.calls.find(item => item.url.startsWith('agent/jobs/')).body.status, 'failed');
  } finally { fs.rmSync(warn.dir, { recursive: true, force: true }); }
  const blank = harness({ renderResult: { ...rendered(), blackPixels: 0, pixelRatio: 0 }, jobs: [job({ id: 'label-test-job-0002' })] });
  try {
    await blank.agent.tick();
    assert.equal(blank.prints.length, 0);
    assert.match(blank.calls.find(item => item.url.startsWith('agent/jobs/')).body.message, /空白/);
  } finally { fs.rmSync(blank.dir, { recursive: true, force: true }); }
});

test('a crash after claiming reconciles as uncertain and never prints again', async () => {
  const dir = mkdir();
  const file = path.join(dir, 'k3-jobs.json');
  const seed = createJournal(file);
  seed.begin(job());
  const journal = createJournal(file);
  const calls = [];
  const prints = [];
  const agent = createAgent({
    journal,
    client: { print: async input => { prints.push(input); return { status: 'printed' }; } },
    render: async () => rendered(), outputDir: dir,
    call: async (url, body) => {
      calls.push({ url, body });
      if (url === 'agent/poll') return { job: journal.entries().length ? job() : null };
      return {};
    },
    log: () => {}
  });
  try {
    await agent.tick();
    const receipt = calls.find(item => item.url.startsWith('agent/jobs/'));
    assert.equal(receipt.body.status, 'uncertain');
    assert.match(receipt.body.message, /接收程序中断/);
    assert.equal(prints.length, 0);
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});

test('same id with different content is rejected before printing', async () => {
  const dir = mkdir(), file = path.join(dir, 'k3-jobs.json');
  const seed = createJournal(file);
  seed.begin(job());
  const journal = createJournal(file);
  const calls = [];
  const prints = [];
  const different = job({ copies: 2 });
  assert.notEqual(signatureOf(job()), signatureOf(different));
  const agent = createAgent({
    journal, client: { print: async input => { prints.push(input); return { status: 'printed' }; } },
    render: async () => rendered(), outputDir: dir,
    call: async (url, body) => {
      calls.push({ url, body });
      if (url === 'agent/poll') return { job: different };
      return {};
    },
    log: () => {}
  });
  try {
    await agent.tick();
    await agent.tick();
    assert.equal(prints.length, 0);
    assert.ok(calls.some(item => /任务编号重复/.test(item.body?.message || '')));
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});

test('bitmap validation rejects wrong lengths and implausible density', () => {
  assert.equal(validBitmap(rendered()), '');
  assert.match(validBitmap({ ...rendered(), rowsBase64: Buffer.alloc(3).toString('base64') }), /行数/);
  assert.match(validBitmap({ ...rendered(), blackPixels: 0 }), /空白/);
  assert.match(validBitmap({ ...rendered(), pixelRatio: 0.99 }), /空白/);
});

test('a lost receipt is re-sent from the journal without reprinting', async () => {
  const dir = mkdir();
  const journal = createJournal(path.join(dir, 'k3-jobs.json'));
  const claimed = journal.begin(job());
  journal.result(job().id, { status: 'queued', message: 'K3 已确认出纸（页 2 → 3）' });
  const calls = [];
  const prints = [];
  let online = false;
  const agent = createAgent({
    journal, outputDir: dir,
    client: { print: async input => { prints.push(input); return { status: 'printed' }; } },
    render: async () => rendered(),
    call: async (url, body) => {
      calls.push({ url, body });
      if (url === 'agent/poll') return { job: online ? job() : null };
      if (url.startsWith('agent/jobs/') && calls.filter(item => item.url === url).length === 1) {
        const error = new Error('网络中断'); error.status = 503; throw error;
      }
      return {};
    },
    log: () => {}
  });
  try {
    await agent.tick();
    assert.equal(claimed.lease, bodyLease(calls));
    assert.notEqual(journal.get(job().id).acknowledged, true);
    await agent.tick();
    assert.equal(journal.get(job().id).acknowledged, true);
    assert.equal(prints.length, 0, 'a recorded print is never repeated to reconcile a receipt');
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});

test('a long print keeps the processing lease alive without printing twice', async () => {
  const dir = mkdir();
  const journal = createJournal(path.join(dir, 'k3-jobs.json'));
  const calls = [];
  const prints = [];
  let release;
  const gate = new Promise(resolve => { release = resolve; });
  let waiting = 0;
  const agent = createAgent({
    journal, outputDir: dir, printHeartbeatMs: 10,
    client: { print: async input => { prints.push(input); await gate; return { status: 'printed', pageBefore: 2, pageAfter: 3 }; } },
    render: async () => rendered(),
    call: async (url, body) => {
      calls.push({ url, body });
      if (url === 'agent/poll') {
        if (body.ready) return { job: prints.length ? null : job() };
        waiting += 1;
        return { job: null };
      }
      return {};
    },
    log: () => {}
  });
  try {
    const running = agent.tick();
    await new Promise(resolve => setTimeout(resolve, 60));
    const beats = calls.filter(item => item.url === 'agent/poll' && item.body.ready === false).length;
    assert.ok(beats >= 3, `expected print heartbeats, got ${beats}`);
    release();
    await running;
    await agent.tick();
    const after = calls.filter(item => item.url === 'agent/poll' && item.body.ready === false).length;
    await new Promise(resolve => setTimeout(resolve, 30));
    assert.equal(calls.filter(item => item.url === 'agent/poll' && item.body.ready === false).length, after, 'heartbeat stops after printing');
    assert.equal(prints.length, 1);
    assert.equal(journal.get(job().id).acknowledged, true);
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});

function bodyLease(calls) {
  return calls.find(item => item.url.startsWith('agent/jobs/')).body.lease;
}
