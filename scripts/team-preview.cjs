const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const express = require('../backend/node_modules/express');
const backendRoot = process.env.BOARD_BACKEND_ROOT ? path.resolve(process.env.BOARD_BACKEND_ROOT) : path.resolve(__dirname, '../backend');
const install = require(path.join(backendRoot, 'team'));

async function start() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'warehouse-team-preview-'));
  process.env.WAREHOUSE_DATA_FILE = path.join(dir,'data.json');
  if (process.env.BOARD_BACKEND_ROOT) {
    process.env.WAREHOUSE_ACCOUNTS_FILE = path.join(dir, 'accounts.json');
    fs.writeFileSync(process.env.WAREHOUSE_ACCOUNTS_FILE, JSON.stringify({ users: [{ id: 'test-admin', username: 'isolated-admin', role: 'admin', disabled: false }], events: [] }));
  }
  fs.writeFileSync(process.env.WAREHOUSE_DATA_FILE, JSON.stringify({products:[],customers:[],suppliers:[],transactions:[],orders:[],ledger:[],_meta:{nextProductId:1,nextCustomerId:1,nextSupplierId:1,nextTransactionId:1,nextLedgerId:1}}));
  const db = require(path.join(backendRoot, 'db'));
  // Match the production JSON limit so file-restore tests exercise the same contract.
  const app=express();app.use(express.json({ limit: '5mb' }));
  app.use((req,res,next)=>{res.set('Access-Control-Allow-Origin','*');res.set('Access-Control-Allow-Methods','GET,POST,PUT,DELETE,OPTIONS');res.set('Access-Control-Allow-Headers','Content-Type, Authorization, If-Match, Idempotency-Key, X-Warehouse-Device');res.set('Access-Control-Expose-Headers','X-Warehouse-Revision');res.set('Access-Control-Max-Age','600');if(req.method==='OPTIONS')return res.sendStatus(204);next();});
  app.use('/api',install(db));
  app.use(express.static(path.resolve('dist')));
  app.get('*',(req,res)=>res.sendFile(path.resolve('dist/index.html')));
  const server=app.listen(Number(process.env.TEAM_PREVIEW_PORT || 4186),'127.0.0.1');
  await new Promise(r=>server.once('listening',r)); return {server,db};
}
if(require.main===module)start().then(()=>console.log('http://127.0.0.1:4186 (isolated preview)'));
module.exports=start;
