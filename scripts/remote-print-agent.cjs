const fs = require('node:fs');
const path = require('node:path');
const { createHash, randomBytes } = require('node:crypto');
const { createPrintService, runNative, startResidentNative, repairSpooler } = require('./dot-matrix-native.cjs');
const { acquireAgentLock } = require('./remote-print-lock.cjs');
const { createBleRelay } = require('./bluetooth-print-relay.cjs');
const { createBleHelperManager } = require('./bluetooth-relay-process.cjs');
function printPayload(job) {
  const n = job.note, paper = job.paper;
  return { id: job.id, printerName: job.printer, document: { key:'delivery-'+n.id, number:n.number, title:'送 货 单', party:n.customer_name, address:n.address, phone:n.phone, receiver:n.receiver, date:n.date, operator:n.sender, orderNumber:'', lines:n.items.map((i,index)=>({id:index+1,product_id:i.product_id||0,type:'out',created_at:0,operator:n.sender,product_name:i.name,specification:i.specification,unit:'个',quantity:i.quantity,unit_price:i.price,amount:i.amount,remark:i.remark})) }, settings:{template:'delivery-note',paper,company:n.company,width:paper==='a4'?210:241,height:paper==='a4'?297:paper==='241-140'?140:93,fontSize:11,rowsPerPage:paper==='a4'?20:paper==='241-140'?10:5,showPrices:true,highClarity:true,offsetX:0,offsetY:0} };
}
function createJournal(file) {
  const data = fs.existsSync(file)?JSON.parse(fs.readFileSync(file,'utf8')):{};
  const rows = () => Object.values(data);
  const terminalBle = new Set(['queued', 'failed']);
  let persistenceError;
  const save = () => {
    if (persistenceError) throw persistenceError;
    let tmp;
    try {
      fs.mkdirSync(path.dirname(file), { recursive: true });
      tmp = file + '.' + process.pid + '.' + randomBytes(6).toString('hex') + '.tmp';
      const fd = fs.openSync(tmp, 'wx', 0o600);
      try { fs.writeFileSync(fd, JSON.stringify(data)); fs.fsyncSync(fd); }
      finally { fs.closeSync(fd); }
      fs.renameSync(tmp, file);
    } catch (error) {
      if (tmp) { try { fs.unlinkSync(tmp); } catch {} }
      persistenceError = Object.assign(new Error('打印记录保存失败，已暂停新任务，请恢复磁盘后重启接收程序'), { code: 'JOURNAL_UNAVAILABLE', statusCode: 503, safeToRetry: false, cause: error });
      throw persistenceError;
    }
  };
  // A process can disappear after handing a job to the renderer but before it
  // records a result. That is an unknown physical outcome, never a safe retry.
  let recovered = false;
  for (const row of rows()) {
    if (row?.kind !== 'ble' && row && !row.result) {
      row.result = { status: 'uncertain', message: '接收程序中断，请检查电脑队列和实际出纸，勿重复发送' };
      recovered = true;
    }
    if (row?.kind === 'ble' && row.status === 'processing') {
      row.status = 'uncertain';
      row.message = '接收程序中断，请检查电脑队列和实际出纸，勿重复发送';
      row.updatedAt = Date.now();
      delete row.payload;
      recovered = true;
    }
  }
  if (recovered) save();
  const hasUncertain = () => !!persistenceError || rows().some(row => row?.kind === 'ble'
    ? row.status === 'uncertain'
    : row?.result?.status === 'uncertain');
  const bleStatus = id => {
    if (persistenceError) throw persistenceError;
    const row = data[id];
    if (!row || row.kind !== 'ble') throw Object.assign(new Error('蓝牙打印任务不存在'), { code: 'JOB_NOT_FOUND', statusCode: 404, safeToRetry: true });
    return row;
  };
  const reserveBle = job => {
    if (persistenceError) throw persistenceError;
    const signature = createHash('sha256').update(JSON.stringify(job)).digest('hex');
    const previous = data[job.id];
    if (previous) {
      if (previous.kind !== 'ble' || previous.signature !== signature) {
        throw Object.assign(new Error('打印任务编号重复且内容不同'), { code: 'JOB_CONFLICT', statusCode: 409, safeToRetry: false });
      }
      // A failed job never crossed the unsafe print boundary and may be
      // retried with the same durable ID. In-flight and completed jobs return
      // their existing state unchanged.
      if (previous.status === 'failed') {
        if (hasUncertain()) throw Object.assign(new Error('上一张打印结果尚未核对，请检查实际出纸后再打印'), { code: 'BLE_PRINT_BLOCKED', statusCode: 409, safeToRetry: false });
        previous.status = 'received';
        previous.attempt = (Number(previous.attempt) || 1) + 1;
        previous.message = '打印电脑已接收，等待处理';
        previous.updatedAt = Date.now();
        previous.payload = job;
        save();
      }
      return { ...previous, created: false };
    }
    if (hasUncertain()) throw Object.assign(new Error('上一张打印结果尚未核对，请检查实际出纸后再打印'), { code: 'BLE_PRINT_BLOCKED', statusCode: 409, safeToRetry: false });
    // Keep compact replay tombstones. Deleting a completed id would let an
    // old phone resend the same job as a new physical copy after retention.
    if (rows().filter(row => row?.kind === 'ble').length >= 5000) {
      throw Object.assign(new Error('蓝牙打印记录已满，请维护接收程序后再打印'), { code: 'BLE_HISTORY_FULL', statusCode: 429 });
    }
    if (rows().filter(row => row?.kind === 'ble' && !terminalBle.has(row.status)).length >= 20) {
      throw Object.assign(new Error('等待打印的蓝牙任务过多，请先处理电脑队列'), { code: 'BLE_QUEUE_FULL', statusCode: 429 });
    }
    const now = Date.now();
    const row = {
      id: job.id,
      kind: 'ble',
      signature,
      attempt: 1,
      payload: job,
      status: 'received',
      message: '打印电脑已接收，等待处理',
      createdAt: now,
      updatedAt: now,
    };
    data[job.id] = row;
    save();
    return { ...row, created: true };
  };
  return {
    entries:()=>rows().filter(row=>row.kind !== 'ble' && (!row.acknowledged || row.result?.status === 'uncertain')),
    hasUncertain,
    reserveBle,
    bleStatus,
    nextBle() {
      if (hasUncertain()) return null;
      return rows().filter(row => row?.kind === 'ble' && row.status === 'received')
        .sort((left, right) => left.createdAt - right.createdAt)[0] || null;
    },
    startBle(id) {
      const row = bleStatus(id);
      if (row.status !== 'received') throw new Error('蓝牙打印任务状态无效');
      row.status = 'processing';
      row.message = '打印电脑正在处理';
      row.updatedAt = Date.now();
      save();
      return row;
    },
    finishBle(id, result) {
      const row = bleStatus(id);
      if (!['queued', 'failed', 'uncertain'].includes(result?.status)) throw new Error('蓝牙打印结果状态无效');
      row.status = result.status;
      row.message = String(result.message || (result.status === 'queued' ? '已送入打印队列' : '打印未完成')).slice(0, 200);
      row.updatedAt = Date.now();
      delete row.payload;
      save();
      return row;
    },
    resolveBle(id, outcome) {
      if (!['printed', 'missing'].includes(outcome)) throw new Error('核对结果无效');
      const row = bleStatus(id);
      if (outcome === 'printed' && row.status === 'queued') {
        if (!Number.isFinite(row.confirmedPrintedAt)) {
          row.confirmedPrintedAt = Date.now();
          row.updatedAt = Math.max(Date.now(), row.updatedAt + 1);
          row.message = '经人工核对，出纸正常';
          save();
        }
        return row;
      }
      if (row.status !== 'uncertain') {
        throw Object.assign(new Error('只有结果未确认的任务可以核对出纸'), { statusCode: 409, safeToRetry: false });
      }
      row.status = outcome === 'printed' ? 'queued' : 'failed';
      row.message = outcome === 'printed' ? '经人工核对，出纸正常' : '经人工核对未出纸，可重新打印';
      row.updatedAt = Date.now();
      if (outcome === 'printed') row.confirmedPrintedAt = row.updatedAt;
      save();
      return row;
    },
    ack(id, receipt) {
      const row = data[id];
      let changed = !row.acknowledged;
      if (row.result?.status === 'uncertain' && receipt?.id === id && ['queued', 'failed'].includes(receipt.status)) {
        row.result = { status: receipt.status, message: String(receipt.message || '人工核对已完成').slice(0, 200) };
        changed = true;
      }
      row.acknowledged = true;
      if (changed) save();
    },
    async submit(job,service){
      const signature=createHash('sha256').update(JSON.stringify(printPayload(job))).digest('hex');
      const previous=data[job.id];
      if(previous){
        if(previous.kind==='ble'||previous.signature!==signature)throw new Error('任务编号重复且内容不同');
        if(!previous.result){previous.result={status:'uncertain',message:'接收程序中断，请检查电脑队列和实际出纸，勿重复发送'};save();}
        return previous;
      }
      const row={id:job.id,lease:job.lease,signature};data[job.id]=row;save();
      if(hasUncertain()){
        row.result={status:'failed',message:'上一张打印结果尚未核对，本任务尚未发送到打印机'};save();return row;
      }
      try{const result=await service.submit(printPayload(job));row.result={status:result.kind==='queued'?'queued':'failed',message:result.kind==='queued'?'已送入打印队列':'未发送到实体打印机'};}
      catch(e){row.result={status:e.safeToRetry===true?'failed':'uncertain',message:e.message};}
      save();return row;
    },
  };
}
function createReceiver({ service, journal, call, printerName, now = Date.now, heartbeatMs = 8000, report = () => {}, started = false, withPrinter = task => task() }) {
  let printers = [], checkedAt = -Infinity, retryAfter = 30000, active;
  let startupReported = !started;
  // A failed enumeration may mean the Windows spooler, not the cable, is down.
  // Starting the service preserves queued work; it does not resubmit a job.
  let enumerationFailures = 0, lastRepairAt = -Infinity;
  const acknowledge = async row => {
    const result = row.result || { status: 'uncertain', message: '接收程序中断，请检查实际出纸，勿重复发送' };
    const receipt = await call('agent/jobs/' + row.id, { lease: row.lease, ...result });
    journal.ack(row.id, receipt);
  };
  const cycle = async () => {
    if (!startupReported) {
      startupReported = true;
      try { await call('agent/recovery', { kind: 'receiver', repaired: true }); }
      catch (error) { report(error); }
    }
    // Never claim new work until previous receipts have been reconciled.
    try { for (const row of journal.entries()) await acknowledge(row); }
    catch (error) { await call('agent/poll', { ready: false }); throw error; }
    // A Bluetooth job with an unknown paper outcome blocks both transports.
    // This is intentional: another channel must not bypass the manual paper
    // reconciliation gate for the same physical 630K printer.
    if (journal.hasUncertain?.()) {
      await call('agent/poll', { ready: false });
      return null;
    }
    if (now() - checkedAt >= retryAfter) {
      try { printers = await withPrinter(() => service.list()); retryAfter = 30000; enumerationFailures = 0; }
      catch (error) {
        printers = [];
        retryAfter = 5000;
        enumerationFailures++;
        report(error);
      }
      checkedAt = now();
    }
    // Only an enumeration exception is evidence of a spooler fault. A printer
    // that is merely offline must wait for its cable; restarting the service
    // repeatedly would not fix that and could interrupt another user's job.
    if (enumerationFailures >= 3 && service.repair && now() - lastRepairAt >= 60000) {
      lastRepairAt = now();
      let outcome;
      try { outcome = await withPrinter(() => service.repair()); } catch (repairError) { report(repairError); }
      // Report only a service that was actually started. Finding Spooler
      // already running means the fault is elsewhere (driver or device).
      if (outcome && outcome.repaired === true) {
        try { await call('agent/recovery', { kind: 'spooler', repaired: true }); }
        catch (error) { report(error); }
      }
      retryAfter = 0;
      checkedAt = -Infinity;
      try {
        printers = await withPrinter(() => service.list());
        retryAfter = 30000;
        enumerationFailures = 0;
      } catch (error) {
        printers = [];
        retryAfter = 5000;
        enumerationFailures++;
        report(error);
      }
    }
    const printer = printers.find(item => item.name === printerName && !item.unavailable && !item.isPdf);
    const poll = await call('agent/poll', { ready: !!printer });
    if (!poll.job) return;
    let heartbeat;
    const timer = setInterval(() => {
      if (heartbeat) return;
      heartbeat = call('agent/poll', { ready: false }).catch(report).finally(() => { heartbeat = undefined; });
    }, heartbeatMs);
    try {
      const selectedService = poll.job.printer === printerName ? service : {
        submit: async () => { throw Object.assign(new Error('打印机配置不符，请检查接收程序配置'), { safeToRetry: true }); }
      };
      const row = await withPrinter(() => journal.submit(poll.job, selectedService));
      await acknowledge(row);
      return row;
    } finally { clearInterval(timer); if (heartbeat) await heartbeat; }
  };
  return { tick() { if (!active) active = cycle().finally(() => { active = undefined; }); return active; }, idle: () => checkedAt !== -Infinity && now() - checkedAt < retryAfter };
}

// Warm Electron hides the per-note startup cost (~500 ms) behind the print
// cycle. It is respawned lazily after a crash, and the persistent journal still
// supplies the deduplication that the old one-process-per-job design relied on.
function createPersistentPrintService() {
  let resident, used = 0;
  const native = () => {
    // Recycle long-lived renderers between notes so a leak in Chromium cannot
    // grow forever; this never interrupts an in-flight print.
    if (!resident || !resident.ready() || used >= 200) { resident?.stop(); resident = startResidentNative(); used = 0; }
    return resident;
  };
  // One service instance keeps the replay memory: a timeout followed by a
  // retry of the same id must not print the note twice.
  const printer = createPrintService(request => native().request(request));
  return {
    list: () => native().request({ action: 'list' }),
    submit: async input => { used++; return printer.submit(input); },
    repair: repairSpooler,
    stop: () => resident?.stop(),
  };
}

async function main(){
  const configFile=process.argv[2];if(!configFile)throw new Error('请指定打印电脑配置文件');
  const config=JSON.parse(fs.readFileSync(configFile,'utf8'));
  if(config.origin!=='https://youxishen.online'||!/^[a-f0-9]{64}$/.test(config.agent))throw new Error('打印电脑配置无效');
  const releaseLock = await acquireAgentLock(configFile);
  let journal;
  try { journal=createJournal(path.join(path.dirname(configFile),'jobs.json')); }
  catch (error) { releaseLock(); throw error; }
  const service = createPersistentPrintService();
  const call=async(url,body)=>{const response=await fetch(config.origin+'/api/remote-print/'+url,{method:'POST',headers:{'Content-Type':'application/json','X-Print-Agent':config.agent},body:JSON.stringify(body),signal:AbortSignal.timeout(12000)});const result=await response.json();if(!response.ok||!result.success)throw new Error(result.message||'连接失败');return result.data;};
  let stopping=false;process.on('SIGTERM',()=>{stopping=true;});process.on('SIGINT',()=>{stopping=true;});
  const report=error=>console.error(new Date().toISOString(),error.message);
  // Every receiver start is an automatic recovery event. A watchdog restart
  // after a hang would otherwise look like a healthy machine with no history.
  const withPrinter = createPrinterCoordinator();
  const receiver=createReceiver({service,journal,call,printerName:config.printer,report,started:true,withPrinter});
  // A hung receiver still looks "running" to Windows, so the launcher's watchdog
  // reads this file instead: `at` proves the event loop turns, `progress`
  // proves the main loop completes rounds. Written only after the lock so a
  // rejected second instance never overwrites the live receiver's beat.
  const heartbeatFile=path.join(path.dirname(configFile),'receiver-heartbeat.json');
  let progress=Date.now();
  const beat=()=>{try{fs.writeFileSync(heartbeatFile+'.tmp',JSON.stringify({pid:process.pid,at:Date.now(),progress}),{mode:0o600});fs.renameSync(heartbeatFile+'.tmp',heartbeatFile);}catch{ /* a missing beat only makes the watchdog more cautious */ }};
  const beatTimer=setInterval(beat,2000);beat();
  const bleCapability = randomBytes(32).toString('hex');
  const bleRelay = createBleRelay({ journal, service, printerName: config.printer, capability: bleCapability, withPrinter });
  let bleHelper;
  let receiverFlight;
  try {
    try {
      const endpoint = await bleRelay.start();
      bleHelper = createBleHelperManager({
        endpoint,
        capability: bleCapability,
        name: `Warehouse-630K-${String(config.printer).replace(/[^a-zA-Z0-9]+/g, '').slice(-8) || 'Relay'}`,
        report,
      });
      bleHelper.start();
    } catch (error) {
      report(new Error('蓝牙中继启动失败，网络打印仍可使用：' + error.message));
    }
    while(!stopping){
      // A disconnected Internet route must not delay local Bluetooth work.
      // Both channels still serialize their durable print boundary below.
      if (!receiverFlight) receiverFlight = receiver.tick().then(row => {
        if (row) console.log(new Date().toISOString(),row.id,row.result.status);
      }).catch(report).finally(() => { receiverFlight = undefined; });
      try {
        const bleJob = await bleRelay.tick();
        if (bleJob) console.log(new Date().toISOString(),bleJob.id,bleJob.status);
      } catch(error){report(error);}
      bleHelper?.ensure();
      progress=Date.now();
      // Idle polling only costs one small HTTPS request, so waiting a full
      // second after every empty cycle just delayed a newly queued note.
      if(!stopping)await new Promise(r=>setTimeout(r,250));
    }
  } finally {
    clearInterval(beatTimer);
    bleHelper?.stop();
    if (receiverFlight) await receiverFlight.catch(report);
    await bleRelay.stop().catch(report);
    service.stop();
    try{fs.unlinkSync(heartbeatFile);}catch{ /* already gone */ }
    releaseLock();
  }
}
if(require.main===module)main().catch(e=>{console.error(e.message);process.exitCode=1;});
function createPrinterCoordinator() {
  let tail = Promise.resolve();
  return task => {
    const result = tail.then(task);
    tail = result.catch(() => {});
    return result;
  };
}
module.exports={printPayload,createJournal,createReceiver,createPersistentPrintService,createPrinterCoordinator,runNative};
