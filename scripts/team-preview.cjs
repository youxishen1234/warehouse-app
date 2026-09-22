const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const express = require('../backend/node_modules/express');
const install = require('../backend/team');
async function start() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'warehouse-team-preview-'));
  process.env.WAREHOUSE_DATA_FILE = path.join(dir,'data.json');
  process.env.WAREHOUSE_ACCOUNTS_FILE = path.join(dir,'accounts.json');
  fs.writeFileSync(process.env.WAREHOUSE_DATA_FILE, JSON.stringify({products:[],customers:[],suppliers:[],transactions:[],orders:[],ledger:[],_meta:{nextProductId:1,nextCustomerId:1,nextSupplierId:1,nextTransactionId:1,nextLedgerId:1}}));
  await install.bootstrap(process.env.WAREHOUSE_ACCOUNTS_FILE, 'Local-preview-password!');
  const db = require('../backend/db');
  const app=express();app.use(express.json());
  app.use((req,res,next)=>{res.set('Access-Control-Allow-Origin','*');res.set('Access-Control-Allow-Headers','Content-Type, Authorization, If-Match, Idempotency-Key');res.set('Access-Control-Expose-Headers','X-Warehouse-Revision');if(req.method==='OPTIONS')return res.sendStatus(204);next();});
  app.use('/api',install(db));
  app.use(express.static(path.resolve('dist')));
  app.get('*',(req,res)=>res.sendFile(path.resolve('dist/index.html')));
  const server=app.listen(Number(process.env.TEAM_PREVIEW_PORT || 4186),'127.0.0.1');
  await new Promise(r=>server.once('listening',r)); return {server,db};
}
if(require.main===module)start().then(()=>console.log('http://127.0.0.1:4186 (isolated preview)'));
module.exports=start;
