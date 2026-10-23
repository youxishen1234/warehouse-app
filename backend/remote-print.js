const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const fail = (message, status = 400) => Object.assign(new Error(message), { status });
const hash = value => crypto.createHash('sha256').update(String(value || '')).digest('hex');
const terminal = new Set(['queued', 'failed', 'uncertain', 'expired']);
function createStore(file, clock = Date.now) {
  const read = () => fs.existsSync(file) ? JSON.parse(fs.readFileSync(file, 'utf8')) : { devices: [], jobs: [] };
  const write = state => {
    fs.mkdirSync(path.dirname(file), { recursive: true });
    const temporary = file + '.tmp-' + crypto.randomUUID();
    try {
      const fd = fs.openSync(temporary, 'wx', 0o600);
      try { fs.writeFileSync(fd, JSON.stringify(state)); fs.fsyncSync(fd); } finally { fs.closeSync(fd); }
      fs.renameSync(temporary, file);
    } finally { if (fs.existsSync(temporary)) fs.unlinkSync(temporary); }
  };
  const authenticate = (state, token, type) => {
    if (!/^[a-f0-9]{64}$/.test(String(token || ''))) throw fail('请先配对打印电脑', 401);
    const device = state.devices.find(row => row[type + '_hash'] === hash(token));
    if (!device) throw fail('打印配对已失效，请重新配对', 401);
    return device;
  };
  const publicDevice = device => ({ id: device.id, name: device.name, printer: device.printer, online: clock() - device.last_seen < 25000, ready: device.ready, last_seen: device.last_seen });
  const publicJob = job => ({ id: job.id, note_id: job.note_id, note_number: job.note_number, status: job.status, message: job.message, created_at: job.created_at, updated_at: job.updated_at });
  const expire = state => {
    for (const job of state.jobs) {
      if (job.status === 'waiting' && clock() - job.created_at > 86400000) { job.status = 'expired'; job.message = '任务已过期，请重新发送'; job.updated_at = clock(); }
      if (job.status === 'processing' && clock() - job.updated_at > 180000) { job.status = 'uncertain'; job.message = '打印结果未确认，请检查电脑队列和出纸，勿重复发送'; job.updated_at = clock(); }
    }
  };
  return {
    register(name, printer) {
      if (!name || name.length > 80 || !printer || printer.length > 256) throw fail('打印电脑资料无效');
      const state = read(), agent = crypto.randomBytes(32).toString('hex'), client = crypto.randomBytes(32).toString('hex');
      const device = { id: crypto.randomUUID(), name, printer, agent_hash: hash(agent), client_hash: hash(client), last_seen: 0, ready: false };
      state.devices.push(device); write(state);
      return { device: publicDevice(device), agent, client };
    },
    device(token) { const state = read(); return publicDevice(authenticate(state, token, 'client')); },
    history(token) { const state=read(),device=authenticate(state,token,'client');const latest=new Map();for(const job of state.jobs){if(job.device_id===device.id&&job.status==='queued'&&(!latest.has(job.note_id)||latest.get(job.note_id).printed_at<job.updated_at))latest.set(job.note_id,{note_id:job.note_id,printed_at:job.updated_at});}return [...latest.values()]; },
    recovery(token) {
      const state = read(), device = authenticate(state, token, 'client');
      const entry = device.recovery;
      if (!entry) return { count: 0, repaired: false, last_kind: 'receiver' };
      return {
        count: Math.min(Number(entry.count) || 0, 1000),
        last_at: Number(entry.at) || undefined,
        last_kind: entry.kind === 'spooler' ? 'spooler' : 'receiver',
        repaired: entry.repaired === true,
      };
    },
    enqueue(token, input, note) {
      const state = read(), device = authenticate(state, token, 'client'); expire(state);
      if (!/^[a-zA-Z0-9-]{16,100}$/.test(input.id || '')) throw fail('打印任务编号无效');
      const fingerprint = hash(JSON.stringify({ note_id: note.id, version: note.version, paper: input.paper }));
      const previous = state.jobs.find(job => job.id === input.id);
      if (previous) { if (previous.device_id !== device.id || previous.fingerprint !== fingerprint) throw fail('任务编号已使用', 409); write(state); return publicJob(previous); }
      if (state.jobs.filter(job => job.device_id === device.id && !terminal.has(job.status)).length >= 20) throw fail('等待打印的单据过多，请先处理电脑队列');
      if (state.jobs.length >= 5000) throw fail('打印任务记录已满，请联系维护');
      const paper = input.paper;
      if (!['241-93', '241-140', 'a4'].includes(paper)) throw fail('纸张无效');
      const job = { id: input.id, device_id: device.id, note_id: note.id, note_number: note.number, fingerprint, note: JSON.parse(JSON.stringify(note)), paper, status: 'waiting', message: '等待打印电脑接收', created_at: clock(), updated_at: clock() };
      state.jobs.push(job); write(state); return publicJob(job);
    },
    status(token, id) { const state = read(), device = authenticate(state, token, 'client'); expire(state); write(state); const job = state.jobs.find(row => row.id === id && row.device_id === device.id); if (!job) throw fail('打印任务不存在', 404); return publicJob(job); },
    claim(token, ready) {
      const state = read(), device = authenticate(state, token, 'agent'); expire(state); device.last_seen = clock(); device.ready = ready === true;
      const blocked = state.jobs.some(job => job.device_id === device.id && ['processing', 'uncertain'].includes(job.status));
      const job = ready === true && !blocked ? state.jobs.find(row => row.device_id === device.id && row.status === 'waiting') : null;
      if (job) { job.status = 'processing'; job.message = '电脑已接收，正在发送打印机'; job.updated_at = clock(); job.lease = crypto.randomBytes(32).toString('hex'); }
      write(state); return { device: publicDevice(device), job: job ? { id: job.id, lease: job.lease, note: job.note, paper: job.paper, printer: device.printer } : null };
    },
    acknowledge(token, id, input) {
      const state = read(), device = authenticate(state, token, 'agent');
      const job = state.jobs.find(row => row.id === id && row.device_id === device.id);
      if (!job || job.lease !== input.lease) throw fail('打印任务凭据无效', 409);
      if (terminal.has(job.status) && job.status !== 'uncertain') return publicJob(job);
      if (!['queued','failed','uncertain'].includes(input.status)) throw fail('打印状态无效');
      job.status = input.status; job.message = input.status === 'queued' ? '已送入630K打印队列，请以实际出纸为准' : String(input.message || '请检查打印电脑').slice(0, 200); job.updated_at = clock();
      if (job.status !== 'uncertain') delete job.note;
      write(state); return publicJob(job);
    },
    recover(token, input) {
      const state = read(), device = authenticate(state, token, 'agent');
      if (!['receiver', 'spooler'].includes(input.kind)) throw fail('恢复记录无效');
      device.last_seen = clock();
      const prior = device.recovery;
      device.recovery = {
        kind: input.kind,
        count: Math.min(1000, (Number(prior?.count) || 0) + 1),
        at: clock(),
        repaired: input.kind === 'spooler' ? input.repaired === true : true
      };
      write(state);
      return { acknowledged: true };
    },
    // An uncertain job blocks the whole device queue by design (never reprint a
    // job that may already have left the printer). Only a person standing at the
    // printer can say what happened, so this resolves it into a terminal state.
    resolve(token, id, input) {
      const state = read(), device = authenticate(state, token, 'client');
      const job = state.jobs.find(row => row.id === id && row.device_id === device.id);
      if (!job) throw fail('打印任务不存在', 404);
      if (job.status !== 'uncertain') throw fail('只有结果未确认的任务需要人工核对', 409);
      const printed = input.outcome === 'printed';
      if (!printed && input.outcome !== 'missing') throw fail('请说明实际是否出纸');
      job.status = printed ? 'queued' : 'failed';
      job.message = printed ? '经人工核对，出纸正常' : '经人工核对未出纸，请重新发送打印';
      job.updated_at = clock(); delete job.note;
      write(state); return publicJob(job);
    },
  };
}
function install(router, db, options = {}) {
  const file = options.file || process.env.WAREHOUSE_REMOTE_PRINT_FILE || path.join(path.dirname(process.env.WAREHOUSE_DATA_FILE || path.join(__dirname,'data.json')), 'remote-print.json');
  const store = createStore(file);
  const route = (method, url, handler) => router[method](url, (req,res,next) => Promise.resolve().then(() => handler(req)).then(data => res.json({success:true,data})).catch(next));
  const client = req => req.get('X-Print-Client'), agent = req => req.get('X-Print-Agent');
  route('get','/remote-print/device',req => store.device(client(req)));
  route('get','/remote-print/history',req => store.history(client(req)));
  route('get','/remote-print/recovery',req => store.recovery(client(req)));
  route('post','/remote-print/jobs',req => {
    store.device(client(req));
    const note = db.listPrintNotes().find(row => row.id === req.body?.note_id);
    if (!note) throw fail('请先保存送货单');
    if (note.version !== req.body.version) throw fail('送货单已更新，请重新打开后打印',409);
    return store.enqueue(client(req),req.body,note);
  });
  route('get','/remote-print/jobs/:id',req => store.status(client(req),req.params.id));
  route('post','/remote-print/jobs/:id/resolve',req => store.resolve(client(req),req.params.id,req.body || {}));
  route('post','/remote-print/agent/poll',req => store.claim(agent(req),req.body?.ready));
  route('post','/remote-print/agent/jobs/:id',req => store.acknowledge(agent(req),req.params.id,req.body || {}));
  route('post','/remote-print/agent/recovery',req => store.recover(agent(req),req.body || {}));
}
module.exports = { createStore, install };
