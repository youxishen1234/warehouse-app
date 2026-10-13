const test=require('node:test'),assert=require('node:assert/strict'),fs=require('node:fs'),os=require('node:os'),path=require('node:path');
const {createJournal,printPayload,createReceiver}=require('../scripts/remote-print-agent.cjs');
const job=()=>({id:'remote-agent-job-001',lease:'lease',printer:'630K',paper:'241-93',note:{id:1,number:'SH1',company:'曙光',customer_name:'客户',date:'2026-10-11',address:'',phone:'',receiver:'',sender:'',items:[{name:'',specification:'400×300×200',quantity:1,price:2,amount:2,remark:''}]}});
test('persistent agent journal never submits a replay or crashed job twice',async()=>{
 const dir=fs.mkdtempSync(path.join(os.tmpdir(),'remote-agent-'));const file=path.join(dir,'jobs.json');let calls=0;
 try{
  const service={submit:async()=>{calls++;return{kind:'queued'};}};
  const journal=createJournal(file),j=job();const result=await journal.submit(j,service);assert.equal(result.result.status,'queued');
  assert.equal((await createJournal(file).submit(j,service)).result.status,'queued');assert.equal(calls,1);
  const data=JSON.parse(fs.readFileSync(file));delete data[j.id].result;fs.writeFileSync(file,JSON.stringify(data));
  assert.equal((await createJournal(file).submit(j,service)).result.status,'uncertain');assert.equal(calls,1);
  assert.equal(printPayload(j).document.lines[0].product_name,'');assert.equal(printPayload(j).settings.height,93);
 }finally{fs.rmSync(dir,{recursive:true,force:true});}
});

test('offline printers and enumeration failures remain visible and recover without restarting',async()=>{
 const dir=fs.mkdtempSync(path.join(os.tmpdir(),'remote-recovery-'));let now=0,failList=true,printed=0;const ready=[];
 try{
  const receiver=createReceiver({printerName:'630K',now:()=>now,journal:createJournal(path.join(dir,'jobs.json')),
   service:{list:async()=>{if(failList)throw new Error('driver unavailable');return[{name:'630K'}];},submit:async()=>{printed++;return{kind:'queued'};}},
   call:async(url,body)=>{if(url==='agent/poll'){ready.push(body.ready);return{job:body.ready?job():null};}return{};}});
  await receiver.tick();assert.deepEqual(ready,[false]);assert.equal(printed,0);
  failList=false;now=5001;await receiver.tick();assert.deepEqual(ready,[false,true]);assert.equal(printed,1);
 }finally{fs.rmSync(dir,{recursive:true,force:true});}
});

test('a lost acknowledgement retries the durable receipt after restart without reprinting',async()=>{
 const dir=fs.mkdtempSync(path.join(os.tmpdir(),'remote-receipt-'));const file=path.join(dir,'jobs.json');let printed=0,ackFails=true,claims=0,acks=0;
 try{
  const service={list:async()=>[{name:'630K'}],submit:async()=>{printed++;return{kind:'queued'};}};
  const call=async(url)=>{if(url==='agent/poll'){claims++;return{job:claims===1?job():null};}acks++;if(ackFails)throw new Error('network interrupted');return{};};
  await assert.rejects(createReceiver({printerName:'630K',journal:createJournal(file),service,call}).tick(),/network/);
  assert.equal(printed,1);assert.equal(createJournal(file).entries().length,1);
  ackFails=false;await createReceiver({printerName:'630K',journal:createJournal(file),service,call}).tick();
  assert.equal(printed,1);assert.equal(acks,2);assert.equal(createJournal(file).entries().length,0);
 }finally{fs.rmSync(dir,{recursive:true,force:true});}
});

test('a long native print keeps heartbeating without claiming another job or submitting twice',async()=>{
 const dir=fs.mkdtempSync(path.join(os.tmpdir(),'remote-heartbeat-'));const ready=[];let finish,started;
 const startedPrint=new Promise(resolve=>{started=resolve;});
 try{
  const receiver=createReceiver({printerName:'630K',heartbeatMs:10,journal:createJournal(path.join(dir,'jobs.json')),
   service:{list:async()=>[{name:'630K'}],submit:()=>{started();return new Promise(resolve=>{finish=resolve;});}},
   call:async(url,body)=>{if(url==='agent/poll'){ready.push(body.ready);return{job:body.ready?job():null};}return{};}});
  const pending=receiver.tick();assert.equal(receiver.tick(),pending);await startedPrint;
  await new Promise(resolve=>setTimeout(resolve,45));finish({kind:'queued'});await pending;
  assert.equal(ready.filter(Boolean).length,1);assert.ok(ready.filter(value=>!value).length>=2);
 }finally{fs.rmSync(dir,{recursive:true,force:true});}
});

test('Windows receiver lock ignores stale/reused PID files but prevents a second live receiver',{skip:process.platform!=='win32'},async()=>{
 const {acquireAgentLock}=require('../scripts/remote-print-lock.cjs');const dir=fs.mkdtempSync(path.join(os.tmpdir(),'remote-lock-'));const config=path.join(dir,'agent.json');let release;
 try{
  fs.writeFileSync(path.join(dir,'agent.lock'),String(process.pid));
  release=await acquireAgentLock(config);
  await assert.rejects(acquireAgentLock(config),/已经运行/);
  release();release=undefined;await new Promise(resolve=>setImmediate(resolve));
  release=await acquireAgentLock(config);
 }finally{release?.();fs.rmSync(dir,{recursive:true,force:true});}
});

test('Windows forcibly terminated receiver releases its lock for automatic restart',{skip:process.platform!=='win32'},async()=>{
 const {spawn}=require('node:child_process');const {once}=require('node:events');
 const {acquireAgentLock}=require('../scripts/remote-print-lock.cjs');
 const dir=fs.mkdtempSync(path.join(os.tmpdir(),'remote-crash-'));const config=path.join(dir,'agent.json');let child,release;
 try{
  const script='require('+JSON.stringify(require.resolve('../scripts/remote-print-lock.cjs'))+').acquireAgentLock(process.argv[1]).then(()=>process.stdout.write("ready"));';
  child=spawn(process.execPath,['-e',script,config],{windowsHide:true,stdio:['ignore','pipe','pipe']});
  await once(child.stdout,'data');
  await assert.rejects(acquireAgentLock(config),/已经运行/);
  const exited=once(child,'exit');child.kill();await exited;
  assert.ok(fs.existsSync(path.join(dir,'agent.lock')),'crash leaves the diagnostic PID file');
  release=await acquireAgentLock(config);
 }finally{if(child&&child.exitCode===null&&child.signalCode===null)child.kill();release?.();fs.rmSync(dir,{recursive:true,force:true});}
});
