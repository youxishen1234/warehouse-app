const test=require('node:test'),assert=require('node:assert/strict'),fs=require('node:fs'),os=require('node:os'),path=require('node:path');
const {createStore,install}=require('./remote-print');
test('paired print jobs persist, claim once, deduplicate, and never resend uncertain work',()=>{
 const dir=fs.mkdtempSync(path.join(os.tmpdir(),'remote-print-'));let now=100000;const file=path.join(dir,'queue.json');
 try{
  const store=createStore(file,()=>now),pair=store.register('店里电脑','EPSON LQ-630K ESC/P2');
  assert.throws(()=>store.device('wrong'),/配对/);assert.throws(()=>store.device(pair.agent),/配对/);
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
  assert.equal(createStore(file,()=>now).claim(pair.agent,true).job.id,'remote-print-task-002');
  const raw=fs.readFileSync(file,'utf8');assert.ok(!raw.includes(pair.client));assert.ok(!raw.includes(pair.agent));
 }finally{fs.rmSync(dir,{recursive:true,force:true});}
});
test('remote routes require pairing and print immutable saved snapshots without stock mutations',async()=>{
 const dir=fs.mkdtempSync(path.join(os.tmpdir(),'remote-print-api-'));const file=path.join(dir,'queue.json');const store=createStore(file),pair=store.register('店里电脑','630K');
 const express=require('express'),app=express();app.use(express.json());const router=express.Router();
 const note={id:1,version:1,number:'SH-001',items:[{name:'',specification:'400×300×200'}]};install(router,{listPrintNotes:()=>[note]},{file});app.use('/api',router);app.use((e,req,res,next)=>res.status(e.status||500).json({message:e.message})); // eslint-disable-line no-unused-vars
 const server=app.listen(0,'127.0.0.1');await new Promise(r=>server.once('listening',r));const base='http://127.0.0.1:'+server.address().port+'/api/remote-print';
 try{
  assert.equal((await fetch(base+'/device')).status,401);
  const call=body=>fetch(base+'/jobs',{method:'POST',headers:{'Content-Type':'application/json','X-Print-Client':pair.client},body:JSON.stringify(body)});
  assert.equal((await call({note_id:1,version:0,id:'remote-route-00001',paper:'241-93'})).status,409);
  const response=await call({note_id:1,version:1,id:'remote-route-00001',paper:'241-93'});assert.equal(response.status,200);
  note.items[0].specification='changed';assert.equal(store.claim(pair.agent,true).job.note.items[0].specification,'400×300×200');
 }finally{server.closeAllConnections();await new Promise(r=>server.close(r));fs.rmSync(dir,{recursive:true,force:true});}
});
