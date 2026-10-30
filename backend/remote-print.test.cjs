const test=require('node:test'),assert=require('node:assert/strict'),fs=require('node:fs'),os=require('node:os'),path=require('node:path');
const {createStore,install}=require('./remote-print');
test('paired print jobs persist, claim once, deduplicate, and never resend uncertain work',()=>{
 const dir=fs.mkdtempSync(path.join(os.tmpdir(),'remote-print-'));let now=100000;const file=path.join(dir,'queue.json');
 try{
  const store=createStore(file,()=>now),pair=store.register('店里电脑','EPSON LQ-630K ESC/P2');
  assert.throws(()=>store.device('wrong'),/连接/);assert.throws(()=>store.device(pair.agent),/连接/);
  const note={id:1,version:1,number:'SH-001',items:[]};const input={id:'remote-print-task-001',paper:'241-93'};
  const job=store.enqueue(pair.client,input,note);assert.equal(job.status,'waiting');
  assert.deepEqual(store.enqueue(pair.client,input,note),job);
  assert.throws(()=>store.enqueue(pair.client,input,{...note,version:2}),/编号/);
  assert.equal(store.claim(pair.agent,false).job,null);
  const claim=store.claim(pair.agent,true).job;assert.equal(claim.id,job.id);assert.equal(store.claim(pair.agent,true).job,null);
  assert.throws(()=>store.acknowledge(pair.agent,job.id,{lease:'bad',status:'queued'}),/凭据/);
  now+=180001;assert.equal(store.status(pair.client,job.id).status,'uncertain');
  store.enqueue(pair.client,{id:'remote-print-task-002',paper:'a4'},note);assert.equal(store.claim(pair.agent,true).job,null);
  store.acknowledge(pair.agent,job.id,{lease:claim.lease,status:'queued'});assert.equal(store.status(pair.client,job.id).status,'queued');
  assert.deepEqual(store.history(pair.client),[{note_id:1,printed_at:now}]);
  const other=store.register('其他电脑','其他打印机');assert.deepEqual(store.history(other.client),[]);
  assert.throws(()=>store.history(pair.agent),/连接/);
  assert.equal(note.printed_at,undefined,'print time stays outside delivery data');
  assert.equal(createStore(file,()=>now).claim(pair.agent,true).job.id,'remote-print-task-002');
  const raw=fs.readFileSync(file,'utf8');assert.ok(!raw.includes(pair.client));assert.ok(!raw.includes(pair.agent));
 }finally{fs.rmSync(dir,{recursive:true,force:true});}
});
test('heartbeat polls do not rewrite the queue file and old finished jobs are pruned',()=>{
 const dir=fs.mkdtempSync(path.join(os.tmpdir(),'remote-print-poll-'));let now=100000;const file=path.join(dir,'queue.json');
 try{
  const store=createStore(file,()=>now),pair=store.register('店里电脑','630K');
  const note={id:1,version:1,number:'SH-001',items:[]};
  store.enqueue(pair.client,{id:'remote-print-task-poll-01',paper:'241-93'},note);
  store.claim(pair.agent,false);
  const before=fs.readFileSync(file,'utf8');
  for(let i=0;i<10;i++){now+=1000;store.claim(pair.agent,false);}
  assert.equal(fs.readFileSync(file,'utf8'),before,'idle polls must not write or fsync the queue');
  // Heartbeats still refresh readiness for the phone after the flush interval.
  now+=16000;store.claim(pair.agent,true);
  assert.equal(JSON.parse(fs.readFileSync(file,'utf8')).devices[0].ready,true);
  // A month of finished history is dropped instead of growing forever.
  const job=JSON.parse(fs.readFileSync(file,'utf8')).jobs[0];
  assert.equal(job.status,'processing');
  now+=31*24*60*60*1000;store.claim(pair.agent,false);
  assert.equal(JSON.parse(fs.readFileSync(file,'utf8')).jobs.length,1,'unfinished work is never pruned');
  assert.equal(JSON.parse(fs.readFileSync(file,'utf8')).devices.length,1,'devices are retained');
 }finally{fs.rmSync(dir,{recursive:true,force:true});}
});
test('remote routes require pairing and print immutable saved snapshots without stock mutations',async()=>{
 const dir=fs.mkdtempSync(path.join(os.tmpdir(),'remote-print-api-'));const file=path.join(dir,'queue.json');const store=createStore(file),pair=store.register('店里电脑','630K');
 const express=require('express'),app=express();app.use(express.json());const router=express.Router();
 const note={id:1,version:1,number:'SH-001',items:[{name:'',specification:'400×300×200'}],outbound_at:100000};install(router,{listPrintNotes:()=>[note]},{file});app.use('/api',router);app.use((e,req,res,next)=>res.status(e.status||500).json({message:e.message})); // eslint-disable-line no-unused-vars
 const server=app.listen(0,'127.0.0.1');await new Promise(r=>server.once('listening',r));const base='http://127.0.0.1:'+server.address().port+'/api/remote-print';
 try{
  assert.equal((await fetch(base+'/device')).status,401);
  const call=body=>fetch(base+'/jobs',{method:'POST',headers:{'Content-Type':'application/json','X-Print-Client':pair.client},body:JSON.stringify(body)});
  assert.equal((await call({note_id:1,version:0,id:'remote-route-00001',paper:'241-93'})).status,409);
  delete note.outbound_at;
  const blocked=await call({note_id:1,version:1,id:'remote-route-unshipped',paper:'241-93'});
  assert.equal(blocked.status,400);assert.match((await blocked.json()).message,/出库/);
  note.temporary_print_at=90000;
  const temporary=await call({note_id:1,version:1,id:'remote-route-temporary-01',paper:'241-93'});assert.equal((await temporary.json()).data.status,'waiting');
  delete note.temporary_print_at;
  note.outbound_at=100000;
  const response=await call({note_id:1,version:1,id:'remote-route-00001',paper:'241-93'});assert.equal(response.status,200);
  note.items[0].specification='changed';assert.equal(store.claim(pair.agent,true).job.note.items[0].specification,'400×300×200');
 }finally{server.closeAllConnections();await new Promise(r=>server.close(r));fs.rmSync(dir,{recursive:true,force:true});}
});

test('only a person at the printer can clear an uncertain job and unblock the queue',()=>{
 const dir=fs.mkdtempSync(path.join(os.tmpdir(),'remote-print-resolve-'));let now=100000;const file=path.join(dir,'queue.json');
 try{
  const store=createStore(file,()=>now),pair=store.register('店里电脑','EPSON LQ-630K ESC/P2');
  const note={id:7,version:1,number:'SH-007',items:[]};
  const first=store.enqueue(pair.client,{id:'remote-print-task-101',paper:'241-93'},note);
  const claim=store.claim(pair.agent,true).job;
  // The receiver dies mid-print: the job becomes uncertain and blocks the device.
  now+=180001;assert.equal(store.status(pair.client,first.id).status,'uncertain');
  store.enqueue(pair.client,{id:'remote-print-task-102',paper:'a4'},note);
  assert.equal(store.claim(pair.agent,true).job,null,'an uncertain job must block new work');

  // A client cannot resolve a job that is not uncertain, or invent an outcome.
  assert.throws(()=>store.resolve(pair.client,'remote-print-task-102',{outcome:'printed'}),/未确认/);
  assert.throws(()=>store.resolve(pair.client,first.id,{outcome:'maybe'}),/出纸/);
  assert.throws(()=>store.resolve(pair.client,'no-such-job',{outcome:'printed'}),/不存在/);
  assert.throws(()=>store.resolve(pair.agent,first.id,{outcome:'printed'}),/连接/);

  // Confirming real output makes it terminal and releases the queue.
  const resolved=store.resolve(pair.client,first.id,{outcome:'printed'});
  assert.equal(resolved.status,'queued');assert.match(resolved.message,/人工核对/);
  assert.equal(store.claim(pair.agent,true).job.id,'remote-print-task-102','the queue must move again');
  assert.throws(()=>store.resolve(pair.client,first.id,{outcome:'missing'}),/未确认/,'a resolved job cannot be re-resolved');
 }finally{fs.rmSync(dir,{recursive:true,force:true});}
});

test('confirming no paper fails the job and still releases the queue',()=>{
 const dir=fs.mkdtempSync(path.join(os.tmpdir(),'remote-print-missing-'));let now=100000;const file=path.join(dir,'queue.json');
 try{
  const store=createStore(file,()=>now),pair=store.register('店里电脑','630K');
  const note={id:9,version:1,number:'SH-009',items:[]};
  const job=store.enqueue(pair.client,{id:'remote-print-task-201',paper:'a4'},note);
  store.claim(pair.agent,true);
  now+=180001;assert.equal(store.status(pair.client,job.id).status,'uncertain');
  const resolved=store.resolve(pair.client,job.id,{outcome:'missing'});
  assert.equal(resolved.status,'failed');assert.match(resolved.message,/重新发送/);
  assert.equal(store.history(pair.client).length,0,'a job that never printed is not print history');
 }finally{fs.rmSync(dir,{recursive:true,force:true});}
});

test('queued jobs can confirm physical output without changing queue status or print history',()=>{
 const dir=fs.mkdtempSync(path.join(os.tmpdir(),'remote-print-printed-confirm-'));let now=100000;const file=path.join(dir,'queue.json');
 try{
  const store=createStore(file,()=>now),pair=store.register('店里电脑','630K');
  const note={id:11,version:1,number:'SH-011',items:[]};
  const queued=store.enqueue(pair.client,{id:'remote-print-confirm-001',paper:'241-93'},note);
  const claim=store.claim(pair.agent,true).job;
  now+=250;
  const accepted=store.acknowledge(pair.agent,queued.id,{lease:claim.lease,status:'queued'});
  const printedAt=accepted.updated_at;
  assert.deepEqual(store.history(pair.client),[{note_id:note.id,printed_at:printedAt}]);
  assert.throws(()=>store.resolve(pair.client,queued.id,{outcome:'missing'}),/只能确认已经出纸/);

  now+=500;
  const confirmed=store.resolve(pair.client,queued.id,{outcome:'printed'});
  assert.equal(confirmed.id,queued.id);
  assert.equal(confirmed.status,'queued','confirming paper does not change the queued task status');
  assert.equal(confirmed.updated_at,printedAt,'confirmation keeps the receiver-accepted timestamp');
  assert.equal(confirmed.confirmed_printed_at,now);
  assert.equal(confirmed.message,'经人工核对，出纸正常');
  assert.deepEqual(store.history(pair.client),[{note_id:note.id,printed_at:printedAt}],'confirmation preserves the original print-history time');

  const persistedAfterFirstConfirmation=fs.readFileSync(file,'utf8');
  const persistedConfirmation=JSON.parse(persistedAfterFirstConfirmation).jobs[0].confirmed_printed_at;
  now+=5000;
  assert.deepEqual(store.resolve(pair.client,queued.id,{outcome:'printed'}),confirmed,'repeated confirmation returns the original receipt');
  assert.equal(fs.readFileSync(file,'utf8'),persistedAfterFirstConfirmation,'idempotent confirmation does not rewrite storage');
  const reloaded=createStore(file,()=>now);
  assert.equal(reloaded.status(pair.client,queued.id).confirmed_printed_at,persistedConfirmation,'confirmation is durable across store reload');
  assert.equal(reloaded.claim(pair.agent,true).job,null,'confirming an already queued job does not re-enqueue it');

  const other=store.register('另一台电脑','630K');
  assert.throws(()=>store.resolve(other.client,queued.id,{outcome:'printed'}),/不存在/,'a paired client cannot confirm another device task');
  assert.throws(()=>store.resolve(pair.agent,queued.id,{outcome:'printed'}),/连接/,'the agent credential cannot use the client confirmation route');
 }finally{fs.rmSync(dir,{recursive:true,force:true});}
});

test('only queued or uncertain tasks accept a printed confirmation',()=>{
 const dir=fs.mkdtempSync(path.join(os.tmpdir(),'remote-print-printed-status-'));let now=100000;const file=path.join(dir,'queue.json');
 try{
  const store=createStore(file,()=>now),pair=store.register('店里电脑','630K');
  const note={id:12,version:1,number:'SH-012',items:[]};
  const waiting=store.enqueue(pair.client,{id:'remote-print-waiting-001',paper:'a4'},note);
  assert.throws(()=>store.resolve(pair.client,waiting.id,{outcome:'printed'}),/未确认/);
  const processing=store.claim(pair.agent,true).job;
  assert.throws(()=>store.resolve(pair.client,processing.id,{outcome:'printed'}),/未确认/);

  now+=180001;
  assert.equal(store.status(pair.client,processing.id).status,'uncertain');
  const resolvedUncertain=store.resolve(pair.client,processing.id,{outcome:'printed'});
  assert.equal(resolvedUncertain.status,'queued','existing uncertain-job confirmation remains supported');
  assert.equal(resolvedUncertain.confirmed_printed_at,now);

  const failed=store.enqueue(pair.client,{id:'remote-print-failed-001',paper:'a4'},note);
  const failedClaim=store.claim(pair.agent,true).job;
  store.acknowledge(pair.agent,failed.id,{lease:failedClaim.lease,status:'failed'});
  assert.throws(()=>store.resolve(pair.client,failed.id,{outcome:'printed'}),/未确认/);

  const expired=store.enqueue(pair.client,{id:'remote-print-expired-001',paper:'a4'},note);
  now+=86400001;
  assert.equal(store.status(pair.client,expired.id).status,'expired');
  assert.throws(()=>store.resolve(pair.client,expired.id,{outcome:'printed'}),/未确认/);
 }finally{fs.rmSync(dir,{recursive:true,force:true});}
});

test('receiver recovery is authenticated, persisted, bounded and visible to the paired phone',()=>{
 const dir=fs.mkdtempSync(path.join(os.tmpdir(),'remote-print-recovery-'));let now=100000;const file=path.join(dir,'queue.json');
 try{
  const store=createStore(file,()=>now),pair=store.register('店里电脑','EPSON LQ-630K ESC/P2');
  assert.deepEqual(store.recovery(pair.client),{count:0,repaired:false,last_kind:'receiver'});
  assert.throws(()=>store.recovery(pair.agent),/连接/);
  assert.throws(()=>store.recover(pair.client,{kind:'receiver'}),/连接/);
  assert.throws(()=>store.recover(pair.agent,{kind:'script'}),/恢复记录/);
  store.recover(pair.agent,{kind:'receiver',repaired:true});
  now+=7000;
  const recovery=store.recover(pair.agent,{kind:'spooler',repaired:true});
  assert.deepEqual(recovery,{acknowledged:true});
  const visible=createStore(file,()=>now).recovery(pair.client);
  assert.equal(visible.count,2);
  assert.equal(visible.last_kind,'spooler');
  assert.equal(visible.repaired,true);
  assert.equal(visible.last_at,now);
  const raw=fs.readFileSync(file,'utf8');
  assert.ok(!raw.includes(pair.agent));
  assert.ok(!raw.includes(pair.client));
 }finally{fs.rmSync(dir,{recursive:true,force:true});}
});

test('label pairing can still resolve the public device without exposing credentials',()=>{
 const dir=fs.mkdtempSync(path.join(os.tmpdir(),'remote-print-agent-device-'));const file=path.join(dir,'queue.json');
 try{
  const store=createStore(file),pair=store.register('店里电脑','EPSON LQ-630K ESC/P2');
  assert.equal(store.agentDevice(pair.agent).id,pair.device.id);
  assert.throws(()=>store.agentDevice(pair.client),/连接/);
  const installed=install({get(){},post(){}},{} ,{file});
  assert.equal(typeof installed.agentDevice,'function','the installed store is available to label registration');
 }finally{fs.rmSync(dir,{recursive:true,force:true});}
});

test('automatic connection requires one explicitly selected default and stays read-only across reloads', t => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'remote-print-auto-default-'));
  const file = path.join(directory, 'queue.json');
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
  const store = createStore(file);
  assert.throws(() => store.autoConnect(), error => error.status === 404);
  assert.equal(fs.existsSync(file), false, 'opening an unconfigured warehouse cannot create credentials');
  const first = store.register('先注册的电脑', '队列一');
  const chosen = store.register('明确选中的电脑', '队列二');
  const beforeSelection = fs.readFileSync(file);
  assert.throws(() => store.autoConnect(), error => error.status === 404);
  assert.deepEqual(fs.readFileSync(file), beforeSelection, 'there is no fallback to the first registered device');

  store.enableAutoConnect(chosen.device.id);
  const connected = store.autoConnect();
  assert.equal(connected.device.id, chosen.device.id);
  assert.match(connected.client, /^[a-f0-9]{64}$/);
  assert.notEqual(connected.client, chosen.client, 'automatic access keeps the original client credential intact');
  assert.deepEqual(Object.keys(connected).sort(), ['client', 'device']);
  assert.deepEqual(Object.keys(connected.device).sort(), ['id', 'last_seen', 'name', 'online', 'printer', 'ready']);
  assert.equal(store.device(chosen.client).id, chosen.device.id);
  assert.equal(store.device(connected.client).id, chosen.device.id);
  assert.equal(store.agentDevice(chosen.agent).id, chosen.device.id);
  assert.throws(() => store.agentDevice(connected.client), error => error.status === 401);
  assert.throws(() => store.enableAutoConnect(first.device.id), error => error.status === 409);
  assert.throws(() => store.register('另一默认电脑', '队列三', { autoConnect: true }), error => error.status === 409);

  const saved = fs.readFileSync(file);
  fs.utimesSync(file, new Date(1000), new Date(1000));
  const modifiedAt = fs.statSync(file).mtimeMs;
  for (let index = 0; index < 20; index++) {
    assert.deepEqual(store.autoConnect(), connected);
    store.enableAutoConnect(chosen.device.id);
  }
  assert.deepEqual(createStore(file).autoConnect(), connected, 'the same phone credential survives a backend restart');
  assert.deepEqual(fs.readFileSync(file), saved);
  assert.equal(fs.statSync(file).mtimeMs, modifiedAt, 'repeated connection and provisioning do not rewrite the store');
  const raw = saved.toString('utf8'), state = JSON.parse(raw);
  assert.equal(state.devices.length, 2);
  assert.equal(state.default_device_id, chosen.device.id);
  for (const credential of [chosen.client, chosen.agent, first.client, first.agent, connected.client]) assert.equal(raw.includes(credential), false);
  assert.match(state.devices[1].auto_connect_secret, /^[a-f0-9]{64}$/);
  assert.match(state.devices[1].auto_client_hash, /^[a-f0-9]{64}$/);
});

test('opt-in registration and automatic clients preserve pending work, old credentials and idempotency', t => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'remote-print-auto-jobs-'));
  const file = path.join(directory, 'queue.json');
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
  let now = 100000;
  const store = createStore(file, () => now);
  const pair = store.register('自动连接电脑', 'EPSON LQ-630K', { autoConnect: true });
  const connected = store.autoConnect();
  assert.equal(connected.device.id, pair.device.id);
  assert.equal(connected.device.online, false, 'connection can return a configured but offline receiver');
  const note = { id: 31, version: 2, number: 'LOCAL-AUTO-31', items: [] };
  const first = store.enqueue(pair.client, { id: 'auto-connection-job-001', paper: '241-93' }, note);
  assert.deepEqual(store.enqueue(connected.client, { id: first.id, paper: '241-93' }, note), first);
  const claim = store.claim(pair.agent, true).job;
  assert.equal(claim.id, first.id);
  store.enqueue(connected.client, { id: 'auto-connection-job-002', paper: '241-93' }, note);
  const before = fs.readFileSync(file);
  store.enableAutoConnect(pair.device.id);
  store.autoConnect();
  assert.deepEqual(fs.readFileSync(file), before, 'connecting never edits pending jobs or leases');
  assert.equal(store.claim(pair.agent, true).job, null);
  now += 180001;
  assert.equal(store.status(connected.client, first.id).status, 'uncertain');
  assert.equal(store.claim(pair.agent, true).job, null, 'automatic connection cannot bypass uncertain-job recovery');
  store.resolve(connected.client, first.id, { outcome: 'printed' });
  assert.equal(store.status(pair.client, first.id).status, 'queued', 'the old phone client still sees the same queue');
  assert.equal(store.claim(pair.agent, true).job.id, 'auto-connection-job-002');
});

test('missing, dangling or corrupt default configuration never selects another printer or mints a new client', t => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'remote-print-auto-invalid-'));
  const file = path.join(directory, 'queue.json');
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
  const store = createStore(file);
  const pair = store.register('默认电脑', '队列', { autoConnect: true });
  const valid = JSON.parse(fs.readFileSync(file, 'utf8'));
  for (const changed of [
    { ...valid, default_device_id: undefined },
    { ...valid, default_device_id: 'removed-device' },
    { ...valid, devices: valid.devices.map(device => ({ ...device, auto_connect_secret: 'invalid' })) },
    { ...valid, devices: valid.devices.map(device => ({ ...device, auto_client_hash: '0'.repeat(64) })) }
  ]) {
    fs.writeFileSync(file, JSON.stringify(changed));
    const before = fs.readFileSync(file);
    assert.throws(() => store.autoConnect(), error => error.status === 404);
    assert.deepEqual(fs.readFileSync(file), before);
    assert.equal(store.device(pair.client).id, pair.device.id, 'an unusable automatic configuration does not revoke old clients');
    assert.equal(store.agentDevice(pair.agent).id, pair.device.id);
  }
});

async function automaticConnectionServer(t) {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'remote-print-auto-api-'));
  const file = path.join(directory, 'queue.json');
  const express = require('express'), app = express(), router = express.Router();
  app.use(express.json());
  app.use((req, _res, next) => { req.warehouseClientIp = 'trusted-test-peer'; next(); });
  const store = install(router, { listPrintNotes() { assert.fail('automatic connection cannot read business data'); } }, { file });
  app.use('/api', router);
  app.use((error, _req, res, _next) => res.status(error.status || 500).json({ success: false, message: error.message })); // eslint-disable-line no-unused-vars
  const server = app.listen(0, '127.0.0.1');
  await new Promise(resolve => server.once('listening', resolve));
  t.after(async () => {
    server.closeAllConnections();
    await new Promise(resolve => server.close(resolve));
    fs.rmSync(directory, { recursive: true, force: true });
  });
  const base = 'http://127.0.0.1:' + server.address().port + '/api/remote-print';
  const connect = (headers = {}, body = {}) => fetch(base + '/connect', {
    method: 'POST', headers: { 'Content-Type': 'application/json', ...headers }, body: JSON.stringify(body)
  });
  return { file, store, base, connect };
}

test('automatic connection route returns only the explicit default credential without accounts or business access', async t => {
  const fixture = await automaticConnectionServer(t);
  const absent = await fixture.connect();
  assert.equal(absent.status, 404);
  assert.equal(absent.headers.get('cache-control'), 'no-store');
  assert.equal(fs.existsSync(fixture.file), false);
  const other = fixture.store.register('其他电脑', '其他队列');
  const pair = fixture.store.register('默认电脑', '630K', { autoConnect: true });
  const before = fs.readFileSync(fixture.file);
  const response = await fixture.connect({ Authorization: 'Bearer anonymous-optional-session' }, { device_id: other.device.id });
  assert.equal(response.status, 200);
  assert.equal(response.headers.get('cache-control'), 'no-store');
  const payload = await response.json();
  assert.equal(payload.success, true);
  assert.deepEqual(Object.keys(payload.data).sort(), ['client', 'device']);
  assert.equal(payload.data.device.id, pair.device.id, 'request data cannot choose a different receiver');
  const serialized = JSON.stringify(payload);
  for (const value of [pair.agent, pair.client, 'auto_connect_secret', 'auto_client_hash', 'agent_hash', 'client_hash']) assert.equal(serialized.includes(value), false);
  const status = await fetch(fixture.base + '/device', { headers: { 'X-Print-Client': payload.data.client } });
  assert.equal(status.status, 200);
  assert.equal((await status.json()).data.id, pair.device.id);
  assert.deepEqual(fs.readFileSync(fixture.file), before, 'the HTTP connection endpoint is read-only');
  assert.equal((await fetch(fixture.base + '/connect')).status, 404, 'credentials cannot be loaded through an image or script GET');
});

test('automatic connection permits warehouse/native origins and rejects unrelated browser sites', async t => {
  const fixture = await automaticConnectionServer(t);
  fixture.store.register('默认电脑', '630K', { autoConnect: true });
  for (const origin of ['https://youxishen.online', 'capacitor://localhost', 'https://localhost', 'http://localhost:18742', 'http://127.0.0.1:18742']) {
    const response = await fixture.connect({ Origin: origin, 'Sec-Fetch-Site': 'cross-site' });
    assert.equal(response.status, 200, origin + ' is an existing warehouse/native source');
  }
  for (const origin of ['https://unrelated.invalid', 'https://youxishen.online.unrelated.invalid', 'https://localhost.unrelated.invalid', 'null']) {
    const response = await fixture.connect({ Origin: origin });
    assert.equal(response.status, 403, origin);
    assert.equal(response.headers.get('cache-control'), 'no-store');
    assert.equal(Object.hasOwn(await response.json(), 'data'), false);
  }
  assert.equal((await fixture.connect({ 'Sec-Fetch-Site': 'cross-site' })).status, 403);
  assert.equal((await fixture.connect({ 'Sec-Fetch-Site': 'same-origin' })).status, 200);
});

test('automatic connection has an IP limit that rotating client-controlled device headers cannot bypass', async t => {
  const fixture = await automaticConnectionServer(t);
  fixture.store.register('默认电脑', '630K', { autoConnect: true });
  const before = fs.readFileSync(fixture.file);
  for (let index = 0; index < 60; index++) {
    const response = await fixture.connect({ 'X-Warehouse-Device': 'phone-' + index, 'X-Forwarded-For': '192.0.2.' + index });
    assert.equal(response.status, 200, 'allowed connection ' + index);
  }
  const limited = await fixture.connect({ 'X-Warehouse-Device': 'new-phone', 'X-Forwarded-For': '198.51.100.42' });
  assert.equal(limited.status, 429);
  assert.equal(limited.headers.get('retry-after'), '60');
  assert.equal(limited.headers.get('cache-control'), 'no-store');
  assert.equal(Object.hasOwn(await limited.json(), 'data'), false);
  assert.deepEqual(fs.readFileSync(fixture.file), before);
});
