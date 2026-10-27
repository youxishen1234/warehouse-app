const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');

const fail = (message, status = 400) => Object.assign(new Error(message), { status });
const hash = value => crypto.createHash('sha256').update(String(value || '')).digest('hex');
const terminal = new Set(['queued', 'failed', 'expired']);
const labelKinds = new Set(['finished-product', 'paperboard-batch', 'paperboard-manual']);
const labelOrigin = 'https://youxishen.online';
const resolverPath = '/pages/label-resolver/index';
const profileFields = ['profileId', 'printerName', 'widthMm', 'heightMm', 'paperStyle', 'density', 'marginMm', 'calibrated'];
const finishedFields = ['productId', 'name', 'specification', 'unit', 'productUrl', 'material', 'corrugation', 'layers', 'weight', 'stockSnapshot', 'printedAt'];
const boardFields = ['customerName', 'material', 'printPlate', 'printColor', 'batchId', 'boardLength', 'boardWidth', 'fluteType', 'supplier', 'batchUrl', 'layers', 'faceGsm', 'linerGsm', 'flutingGsm', 'cartonLength', 'cartonWidth', 'cartonHeight', 'receivedDate', 'location', 'receivedQty', 'remainingQtySnapshot'];
const manualBoardFields = ['customerName', 'boardLength', 'boardWidth', 'boardHeight', 'material', 'printPlate', 'printColor', 'receivedQty', 'receivedDate'];

const isObject = value => Boolean(value) && typeof value === 'object' && !Array.isArray(value);
const has = (value, key) => Object.prototype.hasOwnProperty.call(value, key);
const clone = value => JSON.parse(JSON.stringify(value));
const exactKeys = (value, allowed) => isObject(value) && Object.keys(value).every(key => allowed.includes(key));
const safeName = (value, label, max) => {
  if (typeof value !== 'string') throw fail(`${label}格式无效`);
  const result = value.trim();
  if (!result || result.length > max || /[\u0000-\u001f\u007f\ufffd]/.test(result)) throw fail(`${label}格式无效`);
  return result;
};

function validateLabelId(kind, id) {
  if (kind === 'finished-product' && typeof id === 'number' && Number.isSafeInteger(id)) id = String(id);
  if (kind === 'finished-product' && typeof id === 'string' && /^[1-9][0-9]{0,15}$/.test(id) && Number.isSafeInteger(Number(id))) return id;
  if (kind === 'paperboard-batch' && typeof id === 'string' && /^BOARD-[0-9]{8}-[A-F0-9]{12}$/.test(id)) return id;
  throw fail('标签记录编号无效');
}

function labelUrl(kind, id) {
  return `${labelOrigin}/#${resolverPath}?v=1&kind=${kind}&id=${encodeURIComponent(id)}`;
}

function valueText(value, label, required = true, max = 120) {
  if (value === undefined || value === null) {
    if (!required) return '';
    throw fail(`${label}不能为空`);
  }
  if (typeof value !== 'string') throw fail(`${label}格式无效`);
  const result = value.trim();
  if ((!result && required) || result.length > max || /[\u0000-\u001f\u007f\ufffd]/.test(result)) throw fail(`${label}格式无效`);
  return result;
}

function valueNumber(value, label, positive = false, integer = false) {
  if (typeof value !== 'number' || !Number.isFinite(value) || value < 0 || value > 100000000 ||
      (positive && value === 0) || (integer && !Number.isSafeInteger(value))) throw fail(`${label}格式无效`);
  return value;
}

function optionalText(value, label) {
  return valueText(value, label, false) || undefined;
}

function optionalPositive(value, label, integer = false) {
  if (value === undefined || value === null || value === '' || value === 0) return undefined;
  return valueNumber(value, label, true, integer);
}

function validDate(value) {
  const date = optionalText(value, '日期');
  if (date === undefined) return undefined;
  if (!/^\d{4}-\d{2}-\d{2}$/.test(date) || !Number.isFinite(Date.parse(date)) || new Date(date).toISOString().slice(0, 10) !== date) {
    throw fail('日期无效');
  }
  return date;
}

function finishedSnapshot(product, submitted) {
  if (!isObject(submitted) || !exactKeys(submitted, finishedFields)) throw fail('成品标签字段无效');
  const id = validateLabelId('finished-product', product.id);
  if (product.deleted_at) throw fail('商品已删除或不存在，请重新选择', 409);
  const specification = valueText(product.specification, '商品规格', false, 240);
  const snapshot = {
    productId: Number(id),
    name: valueText(product.name, '商品名称', true, 160),
    specification: specification || `${valueNumber(product.length, '商品长度', true)} × ${valueNumber(product.width, '商品宽度', true)} mm`,
    unit: valueText(product.unit, '库存单位', has(submitted, 'stockSnapshot'), 24),
    productUrl: labelUrl('finished-product', id)
  };
  if (has(submitted, 'material')) {
    const value = optionalText(product.material, '材质');
    if (value !== undefined) snapshot.material = value;
  }
  if (has(submitted, 'corrugation')) {
    const value = optionalText(product.corrugation, '楞型');
    if (value !== undefined) snapshot.corrugation = value;
  }
  if (has(submitted, 'layers')) {
    const value = optionalPositive(product.layers, '层数', true);
    if (value !== undefined) snapshot.layers = value;
  }
  if (has(submitted, 'weight')) {
    const value = optionalPositive(product.weight, '克重');
    if (value !== undefined) snapshot.weight = value;
  }
  if (has(submitted, 'stockSnapshot')) snapshot.stockSnapshot = valueNumber(product.stock, '打印时库存');
  if (has(submitted, 'printedAt')) {
    const printedAt = submitted.printedAt;
    if (typeof printedAt !== 'string' || !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/.test(printedAt) ||
        !Number.isFinite(Date.parse(printedAt)) || new Date(printedAt).toISOString() !== printedAt) throw fail('打印日期无效，请重新预览');
    snapshot.printedAt = printedAt;
  }
  assertSnapshotEqual(submitted, snapshot);
  return snapshot;
}

function boardSnapshot(batch, submitted) {
  if (!isObject(submitted) || !exactKeys(submitted, boardFields)) throw fail('纸板标签字段无效');
  const id = validateLabelId('paperboard-batch', batch.id);
  const snapshot = {
    batchId: id,
    boardLength: valueNumber(batch.boardLength, '纸板长度', true),
    boardWidth: valueNumber(batch.boardWidth, '纸板宽度', true),
    fluteType: valueText(batch.fluteType, '楞型', true, 12),
    supplier: valueText(batch.supplier, '板厂'),
    batchUrl: labelUrl('paperboard-batch', id)
  };
  for (const [field, label] of [['customerName', '客户'], ['material', '材质/配纸'], ['printPlate', '印刷版名'], ['printColor', '颜色']]) {
    if (has(submitted, field)) {
      const value = optionalText(batch[field], label);
      if (value !== undefined) snapshot[field] = value;
    }
  }
  for (const [field, label, integer] of [['layers', '层数', true], ['faceGsm', '面纸克重', false], ['linerGsm', '里纸克重', false], ['flutingGsm', '楞纸克重', false]]) {
    if (has(submitted, field)) {
      const value = optionalPositive(batch[field], label, integer);
      if (value !== undefined) snapshot[field] = value;
    }
  }
  const cartonFields = ['cartonLength', 'cartonWidth', 'cartonHeight'];
  if (cartonFields.some(field => has(submitted, field))) {
    for (const field of cartonFields) snapshot[field] = valueNumber(batch[field], `纸箱${field}`, true);
  }
  if (has(submitted, 'receivedDate')) {
    const value = validDate(batch.date);
    if (value !== undefined) snapshot.receivedDate = value;
  }
  if (has(submitted, 'location')) {
    const value = optionalText(batch.location, '库位');
    if (value !== undefined) snapshot.location = value;
  }
  if (has(submitted, 'receivedQty')) snapshot.receivedQty = valueNumber(batch.receivedQty, '实收数量', false, true);
  if (has(submitted, 'remainingQtySnapshot')) snapshot.remainingQtySnapshot = valueNumber(batch.remainingQty, '打印时余量', false, true);
  assertSnapshotEqual(submitted, snapshot);
  return snapshot;
}

function assertSnapshotEqual(input, canonical) {
  const actualKeys = Object.keys(input).sort();
  const expectedKeys = Object.keys(canonical).sort();
  if (actualKeys.length !== expectedKeys.length || actualKeys.some((key, index) => key !== expectedKeys[index] || input[key] !== canonical[key])) {
    throw fail('标签资料已更新或内容不匹配，请重新打开后打印', 409);
  }
}

function manualBoardSnapshot(submitted) {
  if (!isObject(submitted) || !exactKeys(submitted, manualBoardFields)) throw fail('手填纸板标签字段无效');
  const snapshot = {
    customerName: valueText(submitted.customerName, '客户'),
    boardLength: valueNumber(submitted.boardLength, '纸板长度', true),
    boardWidth: valueNumber(submitted.boardWidth, '纸板宽度', true),
    boardHeight: valueNumber(submitted.boardHeight, '纸板高度', true),
    material: valueText(submitted.material, '材质/配纸')
  };
  for (const [field, label] of [['printPlate', '印刷版名'], ['printColor', '颜色']]) {
    if (has(submitted, field)) {
      const value = optionalText(submitted[field], label);
      if (value !== undefined) snapshot[field] = value;
    }
  }
  if (has(submitted, 'receivedQty')) snapshot.receivedQty = valueNumber(submitted.receivedQty, '数量', false, true);
  if (has(submitted, 'receivedDate')) {
    const value = validDate(submitted.receivedDate);
    if (value !== undefined) snapshot.receivedDate = value;
  }
  assertSnapshotEqual(submitted, snapshot);
  return snapshot;
}

function canonicalSnapshot(db, kind, data) {
  if (!labelKinds.has(kind)) throw fail('标签类型无效');
  if (!isObject(data)) throw fail('标签资料无效');
  if (kind === 'paperboard-manual') return manualBoardSnapshot(data);
  if (kind === 'finished-product') {
    const id = validateLabelId(kind, data.productId);
    const product = db.getProduct(Number(id));
    if (!product || product.deleted_at) throw fail('商品已删除或不存在，请重新选择', 409);
    return finishedSnapshot(product, data);
  }
  const id = validateLabelId(kind, data.batchId);
  const batch = db.listBoards().find(row => row.id === id);
  if (!batch) throw fail('纸板批次已删除或不存在，请重新选择', 409);
  return boardSnapshot(batch, data);
}

function profileSignature(profile) {
  return JSON.stringify({
    profileId: profile.profileId,
    printerName: profile.printerName,
    widthMm: profile.widthMm,
    heightMm: profile.heightMm,
    paperStyle: profile.paperStyle,
    density: profile.density,
    marginMm: { top: profile.marginMm.top, right: profile.marginMm.right, bottom: profile.marginMm.bottom, left: profile.marginMm.left }
  });
}

function validateProfile(input, printer) {
  if (!isObject(input) || !exactKeys(input, profileFields) || !isObject(input.marginMm) ||
      !exactKeys(input.marginMm, ['top', 'right', 'bottom', 'left'])) throw fail('纸张配置格式无效');
  if (typeof input.profileId !== 'string' || !/^[A-Za-z0-9_-]{1,120}$/.test(input.profileId)) throw fail('纸张配置编号无效');
  if (input.printerName !== printer) throw fail('纸张配置打印机与标签打印机不一致');
  if (input.paperStyle !== 'gap') throw fail('标签纸类型无效');
  const widthMm = input.widthMm, heightMm = input.heightMm, density = input.density;
  if (typeof widthMm !== 'number' || !Number.isFinite(widthMm) || widthMm < 20 || widthMm > 120 ||
      typeof heightMm !== 'number' || !Number.isFinite(heightMm) || heightMm < 20 || heightMm > 200) throw fail('标签尺寸必须为宽 20–120 mm、高 20–200 mm');
  if (!Number.isSafeInteger(density) || density < 1 || density > 5) throw fail('打印浓度必须为 1–5');
  const marginMm = {};
  for (const field of ['top', 'right', 'bottom', 'left']) {
    const value = input.marginMm[field];
    if (typeof value !== 'number' || !Number.isFinite(value) || value < 0.5 || value > 30) throw fail('标签边距必须为 0.5–30 mm');
    marginMm[field] = value;
  }
  if (marginMm.left + marginMm.right >= widthMm || marginMm.top + marginMm.bottom >= heightMm) throw fail('标签边距超出纸张尺寸');
  if (input.calibrated !== undefined && typeof input.calibrated !== 'boolean') throw fail('校准状态无效');
  return { profileId: input.profileId, printerName: printer, widthMm, heightMm, paperStyle: 'gap', density, marginMm, calibrated: false };
}

function createStore(file, clock = Date.now) {
  const read = () => fs.existsSync(file) ? JSON.parse(fs.readFileSync(file, 'utf8')) : { devices: [], jobs: [] };
  const write = state => {
    fs.mkdirSync(path.dirname(file), { recursive: true });
    const temporary = file + '.tmp-' + crypto.randomUUID();
    try {
      const fd = fs.openSync(temporary, 'wx', 0o600);
      try { fs.writeFileSync(fd, JSON.stringify(state)); fs.fsyncSync(fd); } finally { fs.closeSync(fd); }
      fs.renameSync(temporary, file);
    } finally {
      if (fs.existsSync(temporary)) fs.unlinkSync(temporary);
    }
  };
  const publicDevice = device => ({
    id: device.device_id, name: device.name, printer: device.printer,
    online: clock() - device.last_seen < 25000, ready: device.ready === true,
    profiles: clone(device.profiles || []), maxCopies: 99
  });
  const publicJob = job => ({
    id: job.id, kind: job.kind, profileId: job.profile_id, copies: job.copies,
    status: job.status, message: job.message, created_at: job.created_at, updated_at: job.updated_at
  });
  const clientDevice = (state, id) => {
    const device = state.devices.find(row => row.device_id === id);
    if (!device) throw fail('这台电脑尚未登记标签打印机', 404);
    return device;
  };
  const authenticateAgent = (state, token) => {
    if (!/^[a-f0-9]{64}$/.test(String(token || ''))) throw fail('标签打印电脑未配对', 401);
    const tokenHash = hash(token);
    const device = state.devices.find(row => row.agent_hash === tokenHash);
    if (!device) throw fail('标签打印配对已失效，请重新登记', 401);
    return device;
  };
  const expire = state => {
    for (const job of state.jobs) {
      if (job.status === 'waiting' && clock() - job.created_at > 86400000) {
        job.status = 'expired'; job.message = '任务已过期，请重新发送'; job.updated_at = clock();
      }
      if (job.status === 'processing' && clock() - job.updated_at > 300000) {
        job.status = 'uncertain'; job.message = '打印结果未确认，请检查电脑队列和出纸，勿重复发送'; job.updated_at = clock();
      }
    }
  };
  const findOwnedJob = (state, deviceId, id) => {
    const job = state.jobs.find(row => row.id === id && row.device_id === deviceId);
    if (!job) throw fail('打印任务不存在', 404);
    return job;
  };

  return {
    register(deliveryDeviceId, name, printer) {
      if (typeof deliveryDeviceId !== 'string' || !deliveryDeviceId || deliveryDeviceId.length > 120) throw fail('送货单打印电脑编号无效');
      name = safeName(name, '打印电脑名称', 80);
      printer = safeName(printer, '标签打印机名称', 256);
      const state = read();
      const agent = crypto.randomBytes(32).toString('hex');
      let device = state.devices.find(row => row.device_id === deliveryDeviceId);
      if (device) {
        if (state.jobs.some(job => job.device_id === deliveryDeviceId && !terminal.has(job.status))) throw fail('该电脑仍有未处理的标签任务，暂不能重新登记', 409);
        if (device.printer !== printer) device.profiles = [];
        device.name = name; device.printer = printer; device.agent_hash = hash(agent); device.last_seen = 0; device.ready = false;
      } else {
        device = { device_id: deliveryDeviceId, name, printer, agent_hash: hash(agent), last_seen: 0, ready: false, profiles: [] };
        state.devices.push(device);
      }
      write(state);
      return { device: publicDevice(device), agent };
    },
    device(deliveryDeviceId) {
      const state = read(); expire(state);
      const device = clientDevice(state, deliveryDeviceId);
      write(state);
      return publicDevice(device);
    },
    saveProfile(deliveryDeviceId, input) {
      const state = read(); expire(state);
      const device = clientDevice(state, deliveryDeviceId);
      const profile = validateProfile(input, device.printer);
      const index = device.profiles.findIndex(row => row.profileId === profile.profileId);
      if (index >= 0 && profileSignature(device.profiles[index]) === profileSignature(profile)) {
        profile.calibrated = device.profiles[index].calibrated === true;
      }
      if (index >= 0) device.profiles[index] = profile; else device.profiles.push(profile);
      write(state);
      return clone(profile);
    },
    enqueue(deliveryDeviceId, input, safeData) {
      const state = read(); expire(state);
      const device = clientDevice(state, deliveryDeviceId);
      if (!isObject(input) || !/^[a-zA-Z0-9-]{16,100}$/.test(input.id || '') ||
          !['calibration', ...labelKinds].includes(input.kind) ||
          typeof input.profileId !== 'string' || !/^[A-Za-z0-9_-]{1,120}$/.test(input.profileId)) throw fail('打印任务格式无效');
      const allowed = input.kind === 'calibration' ? ['id', 'kind', 'profileId', 'copies'] : ['id', 'kind', 'profileId', 'copies', 'data'];
      if (!exactKeys(input, allowed)) throw fail('打印任务包含未知字段');
      if (!Number.isSafeInteger(input.copies) || input.copies < 1 || input.copies > 99) throw fail('打印份数必须为 1–99');
      if (input.kind === 'calibration' && input.copies !== 1) throw fail('校准任务只能打印一张');
      if (input.kind !== 'calibration' && input.copies > 99) throw fail('打印份数超出上限');
      const profile = device.profiles.find(row => row.profileId === input.profileId);
      if (!profile) throw fail('纸张配置不存在，请重新选择', 409);
      if (input.kind === 'paperboard-manual' && (profile.widthMm !== 70 || profile.heightMm !== 100 || profile.density !== 4)) {
        throw fail('手填纸板标签须使用 70 × 100 mm、浓度 4 的纸张配置', 409);
      }
      if (input.kind === 'calibration') {
        if (has(input, 'data') || safeData !== undefined) throw fail('校准任务不应包含标签资料');
      } else {
        if (!profile.calibrated) throw fail('请先完成纸张校准并核对实物', 409);
        if (!isObject(safeData)) throw fail('标签资料无效');
      }
      const fingerprint = hash(JSON.stringify({
        kind: input.kind, profileId: input.profileId, profile: profileSignature(profile),
        copies: input.copies, data: safeData
      }));
      const previous = state.jobs.find(job => job.id === input.id);
      if (previous) {
        if (previous.device_id !== deliveryDeviceId || previous.fingerprint !== fingerprint) throw fail('任务编号已使用', 409);
        write(state);
        return publicJob(previous);
      }
      if (state.jobs.filter(job => job.device_id === deliveryDeviceId && !terminal.has(job.status)).length >= 20) throw fail('等待打印的标签任务过多，请先处理电脑队列');
      if (state.jobs.length >= 5000) throw fail('标签打印记录已满，请联系维护');
      const job = {
        id: input.id, device_id: deliveryDeviceId, fingerprint, kind: input.kind,
        profile_id: profile.profileId, profile_signature: profileSignature(profile),
        profile: clone(profile), copies: input.copies,
        ...(input.kind === 'calibration' ? {} : { data: clone(safeData) }),
        status: 'waiting', message: '等待标签打印电脑接收', created_at: clock(), updated_at: clock()
      };
      state.jobs.push(job); write(state);
      return publicJob(job);
    },
    status(deliveryDeviceId, id) {
      const state = read(); expire(state); write(state);
      return publicJob(findOwnedJob(state, deliveryDeviceId, id));
    },
    claim(agentToken, ready) {
      const state = read(), device = authenticateAgent(state, agentToken);
      expire(state); device.last_seen = clock(); device.ready = ready === true;
      const blocked = state.jobs.some(job => job.device_id === device.device_id && ['processing', 'uncertain'].includes(job.status));
      const job = ready === true && !blocked ? state.jobs.find(row => row.device_id === device.device_id && row.status === 'waiting') : null;
      if (job) {
        job.status = 'processing'; job.message = '标签打印电脑已接收，正在发送 K3'; job.updated_at = clock();
        job.lease = crypto.randomBytes(32).toString('hex');
      } else {
        // The receiver proves it still holds the lease while bytes are sent.
        for (const row of state.jobs) {
          if (row.device_id === device.device_id && row.status === 'processing') row.updated_at = clock();
        }
      }
      write(state);
      return { device: publicDevice(device), job: job ? {
        id: job.id, lease: job.lease, kind: job.kind, profile: clone(job.profile),
        copies: job.copies, ...(job.data === undefined ? {} : { data: clone(job.data) }), printer: device.printer
      } : null };
    },
    acknowledge(agentToken, id, input) {
      const state = read(), device = authenticateAgent(state, agentToken);
      const job = state.jobs.find(row => row.id === id && row.device_id === device.device_id);
      if (!job || typeof input?.lease !== 'string' || job.lease !== input.lease) throw fail('打印任务凭据无效', 409);
      if (job.status === 'queued' || job.status === 'failed') return publicJob(job);
      if (job.status !== 'processing') throw fail('打印任务租约已失效，请核对实际出纸', 409);
      if (!['queued', 'failed', 'uncertain'].includes(input.status)) throw fail('打印状态无效');
      job.status = input.status;
      job.message = input.status === 'queued'
        ? 'K3 已确认出纸，打印完成'
        : String(input.message || (input.status === 'uncertain' ? '打印结果未确认，请检查实物' : '请检查标签打印电脑')).slice(0, 200);
      job.updated_at = clock();
      if (job.status === 'queued' || job.status === 'failed') delete job.data;
      write(state);
      return publicJob(job);
    },
    resolve(deliveryDeviceId, id, input) {
      const state = read(), device = clientDevice(state, deliveryDeviceId);
      const job = findOwnedJob(state, device.device_id, id);
      if (job.status !== 'uncertain') throw fail('只有结果未确认的任务需要人工核对', 409);
      if (!['printed', 'missing'].includes(input?.outcome)) throw fail('请说明实际是否出纸');
      job.status = input.outcome === 'printed' ? 'queued' : 'failed';
      job.message = input.outcome === 'printed' ? '经人工核对，出纸正常' : '经人工核对未出纸，请重新发送打印';
      job.updated_at = clock(); delete job.data; delete job.lease;
      write(state);
      return publicJob(job);
    },
    confirm(deliveryDeviceId, profileId, jobId) {
      const state = read(), device = clientDevice(state, deliveryDeviceId);
      const profile = device.profiles.find(row => row.profileId === profileId);
      if (!profile) throw fail('纸张配置不存在', 404);
      const job = findOwnedJob(state, device.device_id, jobId);
      if (job.status !== 'queued' || job.kind !== 'calibration' || job.profile_id !== profileId ||
          job.profile_signature !== profileSignature(profile)) throw fail('校准任务与当前纸张配置不匹配', 409);
      profile.calibrated = true;
      write(state);
      return clone(profile);
    }
  };
}

function install(router, db, options = {}) {
  const file = options.file || process.env.WAREHOUSE_REMOTE_LABEL_PRINT_FILE ||
    path.join(path.dirname(process.env.WAREHOUSE_DATA_FILE || path.join(__dirname, 'data.json')), 'remote-label-print.json');
  if (typeof options.clientDevice !== 'function') throw new Error('remote-label-print requires the existing remote-print client device resolver');
  if (typeof options.agentDevice !== 'function') throw new Error('remote-label-print requires the existing remote-print agent device resolver');
  const store = createStore(file);
  const route = (method, url, handler) => router[method](url, (req, res, next) =>
    Promise.resolve().then(() => handler(req)).then(data => res.json({ success: true, data })).catch(next));
  const clientId = async req => {
    const device = await options.clientDevice(req.get('X-Print-Client'));
    if (!device || typeof device.id !== 'string' || !device.id) throw fail('请先配对打印电脑', 401);
    return device.id;
  };
  const agent = req => req.get('X-Print-Agent');

  // Registration is authenticated with the already-paired delivery agent, so
  // the shop PC never exposes a second pairing secret or unauthenticated route.
  route('post', '/remote-print/labels/register', async req => {
    const delivery = await options.agentDevice(req.get('X-Print-Agent'));
    if (!delivery || typeof delivery.id !== 'string' || !delivery.id) throw fail('送货单打印电脑未配对', 401);
    return store.register(delivery.id, req.body?.name || delivery.name, req.body?.printer);
  });
  route('get', '/remote-print/labels/device', async req => store.device(await clientId(req)));
  route('post', '/remote-print/labels/profiles', async req => store.saveProfile(await clientId(req), req.body?.profile));
  route('post', '/remote-print/labels/jobs', async req => {
    const deviceId = await clientId(req);
    const input = req.body || {};
    let data;
    if (input.kind !== 'calibration') data = canonicalSnapshot(db, input.kind, input.data);
    return store.enqueue(deviceId, input, data);
  });
  route('get', '/remote-print/labels/jobs/:id', async req => store.status(await clientId(req), req.params.id));
  route('post', '/remote-print/labels/jobs/:id/resolve', async req => store.resolve(await clientId(req), req.params.id, req.body || {}));
  route('post', '/remote-print/labels/profiles/:profileId/confirm', async req => store.confirm(await clientId(req), req.params.profileId, req.body?.jobId));
  route('post', '/remote-print/labels/agent/poll', req => store.claim(agent(req), req.body?.ready));
  route('post', '/remote-print/labels/agent/jobs/:id', req => store.acknowledge(agent(req), req.params.id, req.body || {}));
  return store;
}

module.exports = { createStore, install, canonicalSnapshot };
