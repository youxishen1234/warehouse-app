const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { createStore, install, canonicalSnapshot } = require('./remote-label-print');

const makeProfile = (overrides = {}) => ({
  profileId: 'profile-70x100',
  printerName: 'K3 USB',
  widthMm: 70,
  heightMm: 100,
  paperStyle: 'gap',
  density: 3,
  marginMm: { top: 0.6, right: 0.5, bottom: 0.5, left: 0.5 },
  calibrated: true,
  ...overrides
});
const productFixture = () => ({
  id: 12, name: '成品 A', specification: '70 × 100 mm', unit: '个',
  material: '牛皮纸', corrugation: 'B', layers: 3, weight: 120,
  stock: 6, price: 88.5, supplier_phone: '13800000000'
});
const productSnapshot = (stockSnapshot = 6) => ({
  productId: 12, name: '成品 A', specification: '70 × 100 mm', unit: '个',
  productUrl: 'https://youxishen.online/#/pages/label-resolver/index?v=1&kind=finished-product&id=12',
  material: '牛皮纸', stockSnapshot, printedAt: '2026-10-23T10:00:00.000Z'
});
const mkdir = prefix => fs.mkdtempSync(path.join(os.tmpdir(), prefix));
const close = async server => { server.closeAllConnections(); await new Promise(resolve => server.close(resolve)); };

test('label queue authenticates per registered delivery computer and keeps the agent secret hashed', () => {
  const dir = mkdir('remote-label-store-'), file = path.join(dir, 'labels.json');
  try {
    const store = createStore(file, () => 100000);
    const registered = store.register('delivery-device-1', '店里电脑', 'K3 USB');
    assert.equal(registered.device.id, 'delivery-device-1');
    assert.equal(registered.device.printer, 'K3 USB');
    assert.equal(registered.device.maxCopies, 99);
    assert.equal(registered.device.online, false);
    assert.throws(() => store.claim('wrong-token', true), /配对/);
    assert.throws(() => store.device('not-registered'), /未登记/);

    const saved = store.saveProfile('delivery-device-1', makeProfile());
    assert.equal(saved.calibrated, false, 'client cannot forge a completed calibration');
    assert.throws(() => store.saveProfile('delivery-device-1', makeProfile({ widthMm: 19.9 })), /尺寸/);
    assert.throws(() => store.saveProfile('delivery-device-1', makeProfile({ heightMm: 200.1 })), /尺寸/);
    assert.throws(() => store.saveProfile('delivery-device-1', makeProfile({ density: 6 })), /浓度/);
    assert.throws(() => store.saveProfile('delivery-device-1', makeProfile({
      widthMm: 20, marginMm: { top: 0.5, right: 10, bottom: 0.5, left: 10 }
    })), /边距/);
    assert.throws(() => store.saveProfile('delivery-device-1', makeProfile({ printerName: 'EPSON 630K' })), /打印机/);

    const raw = fs.readFileSync(file, 'utf8');
    assert.ok(!raw.includes(registered.agent), 'only the agent hash is durable');
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});

test('calibration, profile signature, copies, queue expiry, leases, and device ownership are enforced', () => {
  const dir = mkdir('remote-label-flow-'); let now = 100000; const file = path.join(dir, 'labels.json');
  try {
    const store = createStore(file, () => now);
    const first = store.register('delivery-device-1', '店里电脑', 'K3 USB');
    const second = store.register('delivery-device-2', '另一台电脑', 'K3 USB');
    const profile = store.saveProfile(first.device.id, makeProfile());
    const data = { productId: 12, name: '安全快照' };
    assert.throws(() => store.enqueue(first.device.id, {
      id: 'finished-product-before-calibration', kind: 'finished-product', profileId: profile.profileId, copies: 1, data
    }, data), /校准/);
    assert.throws(() => store.enqueue(first.device.id, {
      id: 'calibration-too-many-01', kind: 'calibration', profileId: profile.profileId, copies: 2
    }), /一张/);

    const calibration = store.enqueue(first.device.id, {
      id: 'calibration-job-0001', kind: 'calibration', profileId: profile.profileId, copies: 1
    });
    assert.throws(() => store.status(second.device.id, calibration.id), /不存在/);
    assert.equal(store.claim(first.agent, false).job, null);
    const claim = store.claim(first.agent, true);
    assert.equal(claim.device.ready, true);
    assert.equal(claim.job.kind, 'calibration');
    assert.equal(claim.job.data, undefined);
    assert.throws(() => store.acknowledge(first.agent, calibration.id, { lease: 'bad', status: 'queued' }), /凭据/);

    now += 300001;
    assert.equal(store.status(first.device.id, calibration.id).status, 'uncertain');
    assert.equal(store.claim(first.agent, true).job, null, 'expired processing work blocks subsequent claims');
    assert.throws(() => store.acknowledge(first.agent, calibration.id, { lease: claim.job.lease, status: 'queued' }), /租约/);
    const unrelatedProfile = store.saveProfile(first.device.id, makeProfile({ profileId: 'profile-other' }));
    assert.throws(() => store.confirm(first.device.id, unrelatedProfile.profileId, calibration.id), /不匹配/);
    store.resolve(first.device.id, calibration.id, { outcome: 'printed' });
    assert.equal(store.confirm(first.device.id, profile.profileId, calibration.id).calibrated, true);
    assert.throws(() => store.confirm(first.device.id, profile.profileId, 'unknown-job-id'), /不存在/);
    assert.throws(() => store.confirm(second.device.id, profile.profileId, calibration.id), /不存在/);

    const accepted = store.enqueue(first.device.id, {
      id: 'finished-product-job-0001', kind: 'finished-product', profileId: profile.profileId, copies: 99, data
    }, data);
    assert.equal(accepted.status, 'waiting');
    assert.deepEqual(store.enqueue(first.device.id, {
      id: 'finished-product-job-0001', kind: 'finished-product', profileId: profile.profileId, copies: 99, data
    }, data), accepted, 'same job id and fingerprint is idempotent');
    assert.throws(() => store.enqueue(first.device.id, {
      id: 'finished-product-job-0001', kind: 'finished-product', profileId: profile.profileId, copies: 98, data
    }, data), /编号/);
    assert.throws(() => store.enqueue(first.device.id, {
      id: 'finished-product-job-0002', kind: 'finished-product', profileId: profile.profileId, copies: 100, data
    }, data), /份数/);

    const beforeEdit = store.device(first.device.id).profiles[0];
    assert.equal(beforeEdit.calibrated, true);
    const edited = store.saveProfile(first.device.id, makeProfile({ widthMm: 71 }));
    assert.equal(edited.calibrated, false, 'editing the media resets calibration');
    assert.throws(() => store.confirm(first.device.id, profile.profileId, calibration.id), /不匹配/);
    assert.throws(() => store.enqueue(second.device.id, {
      id: 'finished-product-job-0003', kind: 'finished-product', profileId: profile.profileId, copies: 1, data
    }, data), /纸张配置不存在/);

    const waiting = store.enqueue(second.device.id, {
      id: 'waiting-label-job-0001', kind: 'calibration', profileId: store.saveProfile(second.device.id, makeProfile()).profileId, copies: 1
    });
    now += 86400001;
    assert.equal(store.status(second.device.id, waiting.id).status, 'expired');
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});

test('density 4 paperboard profiles require their own calibration without changing the density 3 profile', () => {
  const dir = mkdir('remote-label-density-');
  try {
    const store = createStore(path.join(dir, 'labels.json'), () => 100000);
    const registered = store.register('delivery-device-1', '店里电脑', 'K3 USB');
    const productProfile = store.saveProfile(registered.device.id, makeProfile());
    const calibration = store.enqueue(registered.device.id, {
      id: 'density-three-calibration-01', kind: 'calibration', profileId: productProfile.profileId, copies: 1
    });
    const claimed = store.claim(registered.agent, true).job;
    store.acknowledge(registered.agent, calibration.id, { lease: claimed.lease, status: 'queued' });
    store.confirm(registered.device.id, productProfile.profileId, calibration.id);

    const boardProfile = store.saveProfile(registered.device.id, makeProfile({ profileId: 'board-density-four', density: 4 }));
    assert.equal(boardProfile.calibrated, false);
    assert.throws(() => store.confirm(registered.device.id, boardProfile.profileId, calibration.id), /不匹配/);
    const data = { batchId: 'BOARD-20261025-ABCDEF123456' };
    assert.throws(() => store.enqueue(registered.device.id, {
      id: 'board-before-density-four-calibration', kind: 'paperboard-batch', profileId: boardProfile.profileId, copies: 1, data
    }, data), /校准/);
    const profiles = store.device(registered.device.id).profiles;
    assert.equal(profiles.find(item => item.profileId === productProfile.profileId).calibrated, true);
    assert.equal(profiles.find(item => item.profileId === productProfile.profileId).density, 3);

    const edited = store.saveProfile(registered.device.id, makeProfile({ density: 4 }));
    assert.equal(edited.calibrated, false, 'changing only density still resets calibration');
    assert.throws(() => store.confirm(registered.device.id, edited.profileId, calibration.id), /不匹配/);
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});

test('canonical snapshots are rebuilt from current product and board records, rejecting forged, stale, deleted, and private fields', () => {
  const product = productFixture();
  const batch = {
    id: 'BOARD-20261023-ABCDEF123456', boardLength: 100, boardWidth: 70, fluteType: 'B',
    supplier: '纸板厂', layers: 3, faceGsm: 150, linerGsm: 120, flutingGsm: 105,
    cartonLength: 40, cartonWidth: 30, cartonHeight: 20, date: '2026-10-23',
    location: 'A-01', receivedQty: 80, remainingQty: 72, unitPrice: 2.4, amount: 192
  };
  const db = { getProduct: id => id === 12 ? product : null, listBoards: () => [batch] };
  const safeProduct = productSnapshot();
  assert.deepEqual(canonicalSnapshot(db, 'finished-product', safeProduct), safeProduct);
  assert.throws(() => canonicalSnapshot(db, 'finished-product', { ...safeProduct, stockSnapshot: 5 }), /已更新/);
  assert.throws(() => canonicalSnapshot(db, 'finished-product', { ...safeProduct, productUrl: 'http://evil.invalid/?id=12' }), /已更新/);
  assert.throws(() => canonicalSnapshot(db, 'finished-product', { ...safeProduct, price: 88.5 }), /字段/);
  assert.ok(!JSON.stringify(canonicalSnapshot(db, 'finished-product', safeProduct)).includes('88.5'));
  assert.ok(!JSON.stringify(canonicalSnapshot(db, 'finished-product', safeProduct)).includes('13800000000'));

  const board = {
    batchId: batch.id, boardLength: 100, boardWidth: 70, fluteType: 'B', supplier: '纸板厂',
    batchUrl: 'https://youxishen.online/#/pages/label-resolver/index?v=1&kind=paperboard-batch&id=BOARD-20261023-ABCDEF123456',
    layers: 3, cartonLength: 40, cartonWidth: 30, cartonHeight: 20,
    receivedDate: '2026-10-23', location: 'A-01', receivedQty: 80, remainingQtySnapshot: 72
  };
  assert.deepEqual(canonicalSnapshot(db, 'paperboard-batch', board), board);
  const withoutBusinessFields = Object.fromEntries(Object.entries(board).filter(([key]) => !['customerName', 'material', 'printPlate', 'printColor'].includes(key)));
  assert.deepEqual(canonicalSnapshot(db, 'paperboard-batch', withoutBusinessFields), withoutBusinessFields, 'pre-existing clients can still print legacy fields');
  for (const field of ['customerName', 'material', 'printPlate', 'printColor']) {
    assert.throws(() => canonicalSnapshot(db, 'paperboard-batch', { ...board, [field]: '伪造内容' }), /已更新/);
  }
  assert.throws(() => canonicalSnapshot(db, 'paperboard-batch', { ...board, remainingQtySnapshot: 71 }), /已更新/);
  assert.throws(() => canonicalSnapshot({ ...db, listBoards: () => [] }, 'paperboard-batch', board), /已删除/);
});

test('HTTP routes reuse X-Print-Client pairing, separate label jobs from the legacy 630K queue, and send only safe snapshots to the agent', async () => {
  const dir = mkdir('remote-label-api-');
  const deliveryFile = path.join(dir, 'delivery.json'), labelFile = path.join(dir, 'labels.json');
  const product = productFixture();
  const note = { id: 5, version: 1, number: 'SH-005', items: [{ name: '旧送货单' }] };
  const db = {
    listPrintNotes: () => [note],
    getProduct: id => id === 12 ? product : null,
    listBoards: () => []
  };
  const express = require('express'), app = express(), router = express.Router();
  app.use(express.json());
  const deliveryStore = require('./remote-print').install(router, db, { file: deliveryFile });
  const deliveryPair = deliveryStore.register('店里电脑', 'EPSON LQ-630K');
  const otherPair = deliveryStore.register('另一台电脑', 'EPSON LQ-630K');
  const labelStore = install(router, db, {
    file: labelFile,
    clientDevice: token => deliveryStore.device(token),
    agentDevice: token => deliveryStore.agentDevice(token)
  });
  const labelPair = labelStore.register(deliveryPair.device.id, '仓库标签机', 'K3 USB');
  app.use('/api', router);
  app.use((error, req, res, next) => res.status(error.status || 500).json({ message: error.message })); // eslint-disable-line no-unused-vars
  const server = app.listen(0, '127.0.0.1');
  await new Promise(resolve => server.once('listening', resolve));
  const base = `http://127.0.0.1:${server.address().port}/api/remote-print/labels`;
  const call = (url, body, token = deliveryPair.client, agent = false) => fetch(base + url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', [agent ? 'X-Print-Agent' : 'X-Print-Client']: token },
    body: JSON.stringify(body)
  });
  try {
    assert.equal((await fetch(base + '/device')).status, 401);
    assert.equal((await fetch(base + '/device', { headers: { 'X-Print-Client': deliveryPair.agent } })).status, 401);
    assert.equal((await call('/agent/poll', { ready: true }, 'bad-token', true)).status, 401);
    const device = await fetch(base + '/device', { headers: { 'X-Print-Client': deliveryPair.client } });
    assert.equal((await device.json()).data.printer, 'K3 USB');

    const profileResponse = await call('/profiles', { profile: makeProfile() });
    assert.equal(profileResponse.status, 200);
    assert.equal((await profileResponse.json()).data.calibrated, false);
    const calibrationResponse = await call('/jobs', { id: 'api-calibration-job-01', kind: 'calibration', profileId: 'profile-70x100', copies: 1 });
    assert.equal(calibrationResponse.status, 200);
    const calibration = (await calibrationResponse.json()).data;
    const calibrationClaim = (await (await call('/agent/poll', { ready: true }, labelPair.agent, true)).json()).data.job;
    const calibrationAck = await call(`/agent/jobs/${calibration.id}`, {
      lease: calibrationClaim.lease, status: 'queued'
    }, labelPair.agent, true);
    assert.equal(calibrationAck.status, 200);
    const mismatchConfirm = await call('/profiles/another-profile/confirm', { jobId: calibration.id });
    assert.equal(mismatchConfirm.status, 404);
    assert.equal((await call('/profiles/profile-70x100/confirm', { jobId: calibration.id })).status, 200);

    const staleSnapshot = productSnapshot(6);
    product.stock = 7;
    assert.equal((await call('/jobs', {
      id: 'api-stale-product-job-01', kind: 'finished-product', profileId: 'profile-70x100', copies: 1, data: staleSnapshot
    })).status, 409);
    const forged = { ...productSnapshot(7), supplier_phone: product.supplier_phone };
    assert.equal((await call('/jobs', {
      id: 'api-forged-product-job-01', kind: 'finished-product', profileId: 'profile-70x100', copies: 1, data: forged
    })).status, 400);
    const accepted = await call('/jobs', {
      id: 'api-valid-product-job-01', kind: 'finished-product', profileId: 'profile-70x100', copies: 1, data: productSnapshot(7)
    });
    assert.equal(accepted.status, 200);
    const job = (await accepted.json()).data;
    assert.equal((await call(`/jobs/${job.id}`, {}, otherPair.client)).status, 404);
    const claim = (await (await call('/agent/poll', { ready: true }, labelPair.agent, true)).json()).data.job;
    assert.equal(claim.kind, 'finished-product');
    assert.equal(claim.printer, 'K3 USB');
    assert.deepEqual(claim.data, productSnapshot(7));
    assert.ok(!JSON.stringify(claim).includes('88.5'));
    assert.ok(!JSON.stringify(claim).includes('13800000000'));
    const queued = await call(`/agent/jobs/${job.id}`, { lease: claim.lease, status: 'queued' }, labelPair.agent, true);
    assert.equal((await queued.json()).data.message, 'K3 已确认出纸，打印完成');
    assert.deepEqual(await deliveryStore.history(deliveryPair.client), []);
    deliveryStore.enqueue(deliveryPair.client, { id: 'legacy-630k-job-0001', paper: '241-93' }, note);
    assert.equal(deliveryStore.claim(deliveryPair.agent, true).job.note.id, 5, 'legacy device still receives only its 630K job');
    assert.equal((await labelStore.claim(labelPair.agent, true)).job, null, 'completed label work is not visible in the delivery queue');

    // The shop PC registers its label channel with the delivery agent token it
    // already has. The returned label token is independent of that secret.
    const deliveryDevice = await fetch(base.replace('/labels', '') + '/agent/device', {
      headers: { 'X-Print-Agent': deliveryPair.agent }
    });
    assert.equal(deliveryDevice.status, 200);
    assert.equal((await deliveryDevice.json()).data.id, deliveryPair.device.id);
    assert.equal((await fetch(base.replace('/labels', '') + '/agent/device', {
      headers: { 'X-Print-Agent': deliveryPair.client }
    })).status, 401);
    const registration = await fetch(base + '/register', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'X-Print-Agent': deliveryPair.agent },
      body: JSON.stringify({ name: '仓库标签机', printer: 'K3 USB' })
    });
    assert.equal(registration.status, 200);
    const registered = (await registration.json()).data;
    assert.equal(registered.device.id, deliveryPair.device.id);
    assert.match(registered.agent, /^[a-f0-9]{64}$/);
    assert.notEqual(registered.agent, deliveryPair.agent);
    assert.equal((await fetch(base + '/register', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'X-Print-Agent': 'f'.repeat(64) },
      body: JSON.stringify({ name: '仓库标签机', printer: 'K3 USB' })
    })).status, 401);
    const afterReRegister = await call('/agent/poll', { ready: false }, registered.agent, true);
    assert.equal(afterReRegister.status, 200);
    assert.deepEqual(await deliveryStore.history(deliveryPair.client), [], 'label registration does not create a delivery-note job');
  } finally {
    await close(server);
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('business board fields are canonical, reject stale or forged values without inventory writes', () => {
 const batch={id:'BOARD-20261023-ABCDEF123456',boardLength:100,boardWidth:70,fluteType:'B',supplier:'纸板厂',customerName:'客户甲',material:'牛卡',printPlate:'包装A',printColor:'红黑',remainingQty:0};
 const db={listBoards:()=>[batch]};
 const base={batchId:batch.id,boardLength:100,boardWidth:70,fluteType:'B',supplier:'纸板厂',batchUrl:'https://youxishen.online/#/pages/label-resolver/index?v=1&kind=paperboard-batch&id='+batch.id};
 const snapshot={...base,customerName:batch.customerName,material:batch.material,printPlate:batch.printPlate,printColor:batch.printColor,remainingQtySnapshot:0};
 const before=JSON.stringify(batch);
 assert.deepEqual(canonicalSnapshot(db,'paperboard-batch',snapshot),snapshot);
 for(const field of ['customerName','material','printPlate','printColor']) assert.throws(()=>canonicalSnapshot(db,'paperboard-batch',{...snapshot,[field]:'伪造'}),/已更新/);
 assert.deepEqual(canonicalSnapshot(db,'paperboard-batch',base),base,'old clients remain compatible');
 assert.equal(JSON.stringify(batch),before);
});
