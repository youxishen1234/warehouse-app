const fs = require('node:fs');
const path = require('node:path');
const { createHash } = require('node:crypto');
const { createPrintService, runNative } = require('./dot-matrix-native.cjs');
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
async function main(){
  const configFile=process.argv[2];if(!configFile)throw new Error('请指定打印电脑配置文件');
  const config=JSON.parse(fs.readFileSync(configFile,'utf8'));
  if(config.origin!=='https://youxishen.online'||!/^[a-f0-9]{64}$/.test(config.agent))throw new Error('打印电脑配置无效');
  const service=createPrintService();const journal=createJournal(path.join(path.dirname(configFile),'jobs.json'));
  const call=async(url,body)=>{const response=await fetch(config.origin+'/api/remote-print/'+url,{method:'POST',headers:{'Content-Type':'application/json','X-Print-Agent':config.agent},body:JSON.stringify(body),signal:AbortSignal.timeout(12000)});const result=await response.json();if(!response.ok||!result.success)throw new Error(result.message||'连接失败');return result.data;};
  let stopping=false;process.on('SIGTERM',()=>{stopping=true;});process.on('SIGINT',()=>{stopping=true;});
  const lock=path.join(path.dirname(configFile),'agent.lock');
  let fd;try{fd=fs.openSync(lock,'wx',0o600);fs.writeFileSync(fd,String(process.pid));}catch{const pid=Number(fs.readFileSync(lock,'utf8'));try{process.kill(pid,0);throw new Error('打印接收程序已经运行');}catch(e){if(e.code!=='ESRCH')throw e;fs.unlinkSync(lock);fd=fs.openSync(lock,'wx',0o600);fs.writeFileSync(fd,String(process.pid));}}
  process.on('exit',()=>{try{fs.closeSync(fd);fs.unlinkSync(lock);}catch{ /* shutdown */ }});
  let printers=[],checkedAt=0;
  while(!stopping){
    try{
      for(const row of journal.entries()) { if(!row.result){row.result={status:'uncertain',message:'接收程序中断，请检查实际出纸'};} await call('agent/jobs/'+row.id,{lease:row.lease,...row.result});journal.ack(row.id); }
      if(Date.now()-checkedAt>30000){printers=await service.list();checkedAt=Date.now();}
      const printer=printers.find(p=>p.name===config.printer&&!p.unavailable&&!p.isPdf);
      const poll=await call('agent/poll',{ready:!!printer});
      if(poll.job){if(poll.job.printer!==config.printer)throw new Error('打印机配置不符');const row=await journal.submit(poll.job,service);await call('agent/jobs/'+row.id,{lease:row.lease,...row.result});journal.ack(row.id);console.log(new Date().toISOString(),row.id,row.result.status);}
    }catch(e){console.error(new Date().toISOString(),e.message);}
    await new Promise(r=>setTimeout(r,1000));
  }
}
if(require.main===module)main().catch(e=>{console.error(e.message);process.exitCode=1;});
module.exports={printPayload,createJournal,runNative};
