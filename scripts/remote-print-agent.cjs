const fs = require('node:fs');
const path = require('node:path');
const { createHash } = require('node:crypto');
const { createPrintService, runNative } = require('./dot-matrix-native.cjs');
const { acquireAgentLock } = require('./remote-print-lock.cjs');
function printPayload(job) {
  const n = job.note, paper = job.paper;
  return { id: job.id, printerName: job.printer, document: { key:'delivery-'+n.id, number:n.number, title:'送 货 单', party:n.customer_name, address:n.address, phone:n.phone, receiver:n.receiver, date:n.date, operator:n.sender, orderNumber:'', lines:n.items.map((i,index)=>({id:index+1,product_id:i.product_id||0,type:'out',created_at:0,operator:n.sender,product_name:i.name,specification:i.specification,unit:'个',quantity:i.quantity,unit_price:i.price,amount:i.amount,remark:i.remark})) }, settings:{template:'delivery-note',paper,company:n.company,width:paper==='a4'?210:241,height:paper==='a4'?297:paper==='241-140'?140:93,fontSize:11,rowsPerPage:paper==='a4'?20:paper==='241-140'?10:5,showPrices:true,highClarity:true,offsetX:0,offsetY:0} };
}
function createJournal(file) {
  const data = fs.existsSync(file)?JSON.parse(fs.readFileSync(file,'utf8')):{};
  const save=()=>{fs.mkdirSync(path.dirname(file),{recursive:true});const tmp=file+'.tmp';const fd=fs.openSync(tmp,'w',0o600);try{fs.writeFileSync(fd,JSON.stringify(data));fs.fsyncSync(fd);}finally{fs.closeSync(fd);}fs.renameSync(tmp,file);};
  return {
    entries:()=>Object.values(data).filter(row=>!row.acknowledged),
    ack(id){data[id].acknowledged=true;save();},
    async submit(job,service){
      const signature=createHash('sha256').update(JSON.stringify(printPayload(job))).digest('hex');
      const previous=data[job.id];
      if(previous){if(previous.signature!==signature)throw new Error('任务编号重复且内容不同');if(!previous.result){previous.result={status:'uncertain',message:'接收程序中断，请检查电脑队列和实际出纸，勿重复发送'};save();}return previous;}
      const row={id:job.id,lease:job.lease,signature};data[job.id]=row;save();
      try{const result=await service.submit(printPayload(job));row.result={status:result.kind==='queued'?'queued':'failed',message:result.kind==='queued'?'已送入打印队列':'未发送到实体打印机'};}
      catch(e){row.result={status:e.safeToRetry===true?'failed':'uncertain',message:e.message};}
      save();return row;
    },
  };
}
function createReceiver({ service, journal, call, printerName, now = Date.now, heartbeatMs = 8000, report = () => {} }) {
  let printers = [], checkedAt = -Infinity, retryAfter = 30000, active;
  const acknowledge = async row => {
    const result = row.result || { status: 'uncertain', message: '接收程序中断，请检查实际出纸，勿重复发送' };
    await call('agent/jobs/' + row.id, { lease: row.lease, ...result });
    journal.ack(row.id);
  };
  const cycle = async () => {
    // Never claim new work until previous receipts have been reconciled.
    try { for (const row of journal.entries()) await acknowledge(row); }
    catch (error) { await call('agent/poll', { ready: false }); throw error; }
    if (now() - checkedAt >= retryAfter) {
      try { printers = await service.list(); retryAfter = 30000; }
      catch (error) { printers = []; retryAfter = 5000; report(error); }
      checkedAt = now();
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
      const row = await journal.submit(poll.job, selectedService);
      await acknowledge(row);
      return row;
    } finally { clearInterval(timer); if (heartbeat) await heartbeat; }
  };
  return { tick() { if (!active) active = cycle().finally(() => { active = undefined; }); return active; } };
}

async function main(){
  const configFile=process.argv[2];if(!configFile)throw new Error('请指定打印电脑配置文件');
  const config=JSON.parse(fs.readFileSync(configFile,'utf8'));
  if(config.origin!=='https://youxishen.online'||!/^[a-f0-9]{64}$/.test(config.agent))throw new Error('打印电脑配置无效');
  const journal=createJournal(path.join(path.dirname(configFile),'jobs.json'));
  // The persistent journal provides deduplication. A fresh native service per
  // job avoids hitting the preview service's 500-job in-memory session limit.
  const service={list:()=>runNative({action:'list'}),submit:input=>createPrintService().submit(input)};
  const call=async(url,body)=>{const response=await fetch(config.origin+'/api/remote-print/'+url,{method:'POST',headers:{'Content-Type':'application/json','X-Print-Agent':config.agent},body:JSON.stringify(body),signal:AbortSignal.timeout(12000)});const result=await response.json();if(!response.ok||!result.success)throw new Error(result.message||'连接失败');return result.data;};
  let stopping=false;process.on('SIGTERM',()=>{stopping=true;});process.on('SIGINT',()=>{stopping=true;});
  const report=error=>console.error(new Date().toISOString(),error.message);
  const receiver=createReceiver({service,journal,call,printerName:config.printer,report});
  const releaseLock = await acquireAgentLock(configFile);
  // A hung receiver still looks "running" to Windows, so the launcher's watchdog
  // reads this file instead: `at` proves the event loop turns, `progress`
  // proves the main loop completes rounds. Written only after the lock so a
  // rejected second instance never overwrites the live receiver's beat.
  const heartbeatFile=path.join(path.dirname(configFile),'receiver-heartbeat.json');
  let progress=Date.now();
  const beat=()=>{try{fs.writeFileSync(heartbeatFile+'.tmp',JSON.stringify({pid:process.pid,at:Date.now(),progress}),{mode:0o600});fs.renameSync(heartbeatFile+'.tmp',heartbeatFile);}catch{ /* a missing beat only makes the watchdog more cautious */ }};
  const beatTimer=setInterval(beat,2000);beat();
  try {
    while(!stopping){
      try { const row=await receiver.tick(); if(row)console.log(new Date().toISOString(),row.id,row.result.status); }
      catch(error){report(error);}
      progress=Date.now();
      if(!stopping)await new Promise(r=>setTimeout(r,1000));
    }
  } finally { clearInterval(beatTimer); try{fs.unlinkSync(heartbeatFile);}catch{ /* already gone */ } releaseLock(); }
}
if(require.main===module)main().catch(e=>{console.error(e.message);process.exitCode=1;});
module.exports={printPayload,createJournal,createReceiver,runNative};
