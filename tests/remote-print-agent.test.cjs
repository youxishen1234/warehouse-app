const test=require('node:test'),assert=require('node:assert/strict'),fs=require('node:fs'),os=require('node:os'),path=require('node:path');
const {createJournal,printPayload}=require('../scripts/remote-print-agent.cjs');
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
