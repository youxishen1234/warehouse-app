// 无扫码版仓库系统 - 后端服务 (端口 4000，监听所有网卡)
const express = require('express');
const path = require('path');
const os = require('os');
const db = require('./db');
const updates = require('./updates');

const app = express();
const PORT = Number(process.env.PORT || 4000);

app.set('trust proxy', true); // 取 cloudflare 隧道真实 IP
// 原生 Capacitor App 的页面来源是 capacitor://localhost；为 API 和更新包允许跨域访问。
app.use((req, res, next) => {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET,POST,PUT,DELETE,OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization, Idempotency-Key, If-Match, X-Warehouse-Device');
  res.setHeader('Access-Control-Expose-Headers', 'X-Warehouse-Revision');
  if (req.method === 'OPTIONS') return res.sendStatus(204);
  next();
});
app.use(express.json({ limit: '5mb' }));
app.use('/api', require('./team')(db));

// 热更新静态文件访问日志（旧版 App 直接拉 manifest.json / www.zip）
app.use('/appupdate', (req, res, next) => {
  // 注意：req.path 必须在进入时捕获——finish 触发时 Express 已把 req.url 还原成完整路径
  const file = req.path.replace(/^\//, '');
  const isUpdateFile = file === 'manifest.json' || file === 'www.zip';
  res.on('finish', () => {
    if (req.method !== 'GET' || !isUpdateFile) return;
    updates.logEvent({
      event: file === 'manifest.json' ? 'manifest_fetch' : 'zip_download',
      ip: updates.clientIp(req),
      message: res.statusCode + ' ' + (res.getHeader('content-length') || 0) + 'B'
    });
  });
  next();
});


// 为 IPA 文件添加下载头，让浏览器触发下载而不是黑屏
app.get('/shuguang.ipa', (req, res) => {
  const filePath = path.join(__dirname, 'public', 'shuguang.ipa');
  res.setHeader('Content-Disposition', 'attachment; filename="shuguang.ipa"');
  res.sendFile(filePath);
});

app.get('/download/shuguang.ipa', (req, res) => {
  const filePath = path.join(__dirname, 'public', 'download', 'shuguang.ipa');
  res.setHeader('Content-Disposition', 'attachment; filename="shuguang.ipa"');
  res.sendFile(filePath);
});

app.use(express.static(path.join(__dirname, 'public')));

// ============ App 热更新服务 ============
// 版本检查：客户端启动时带 设备ID/平台/原生版本/当前热更版本 来询
app.get('/api/appupdate/check', (req, res) => {
  try {
    const m = updates.readManifest();
    if (!m || !m.version) return res.status(404).json({ success: false, message: '暂无更新包' });
    const q = req.query;
    updates.logEvent({
      event: 'check',
      ip: updates.clientIp(req),
      device_id: q.device_id || '',
      platform: q.platform || '',
      native_version: q.native_version || '',
      current: q.current || ''
    });
    res.json({
      success: true,
      data: {
        version: m.version,
        url: m.url || 'www.zip',
        publishedAt: m.publishedAt || '',
        releaseNotes: m.releaseNotes || '',
        forceUpdate: !!m.forceUpdate,
        minNativeVersion: m.minNativeVersion || null,
        update: (q.current || '') !== m.version
      }
    });
  } catch (e) {
    res.status(500).json({ success: false, message: e.message });
  }
});

// 事件上报：downloaded / download_failed / pending_restart / installed
app.post('/api/appupdate/report', (req, res) => {
  try {
    const b = req.body || {};
    if (!updates.REPORT_EVENTS.includes(b.event)) {
      return res.status(400).json({ success: false, message: '未知事件: ' + b.event });
    }
    updates.logEvent({
      event: b.event,
      ip: updates.clientIp(req),
      device_id: b.device_id || '',
      platform: b.platform || '',
      native_version: b.native_version || '',
      current: b.current || '',
      from_version: b.from_version || '',
      to_version: b.to_version || '',
      message: b.message || ''
    });
    res.json({ success: true });
  } catch (e) {
    res.status(500).json({ success: false, message: e.message });
  }
});

// 更新统计：设备数、版本分布、安装/失败数、最近事件
app.get('/api/appupdate/stats', (req, res) => {
  try {
    res.json({ success: true, data: updates.stats(Number(req.query.recent) || 50) });
  } catch (e) {
    res.status(500).json({ success: false, message: e.message });
  }
});

// 发布新版本：返回热更新版本信息 + App 安装包下载链接（完整可下载地址，随访问域名自动变化）
app.get('/api/app/downloads', (req, res) => {
  try {
    const fs = require('fs');
    const m = updates.readManifest();
    const publicDir = path.join(__dirname, 'public');
    const has = f => fs.existsSync(path.join(publicDir, f));
    const origin = `${req.protocol}://${req.get('host')}`;
    res.json({
      success: true,
      data: {
        hotVersion: m && m.version ? m.version : null,
        publishedAt: m && m.publishedAt ? m.publishedAt : '',
        releaseNotes: m && m.releaseNotes ? m.releaseNotes : '',
        ipa: has('shuguang.ipa') ? `${origin}/shuguang.ipa` : null,
        apk: has('shuguang.apk') ? `${origin}/shuguang.apk` : null
      }
    });
  } catch (e) {
    res.status(500).json({ success: false, message: e.message });
  }
});

const ok = (res,d)=>res.json({success:true,data:d});
const fail = (res,e,s=400)=>res.status(s).json({success:false,message:e.message||String(e)});

app.get('/api/stats', (req,res)=>{ try{ok(res,db.stats())}catch(e){fail(res,e)}});

app.get('/api/products', (req,res)=>{ try{ok(res,db.listProducts(req.query))}catch(e){fail(res,e)}});
app.get('/api/products/:id', (req,res)=>{
  try{ const p = db.getProduct(Number(req.params.id)); if(!p) return fail(res,new Error('商品不存在'),404); ok(res,p); }catch(e){fail(res,e)}
});
app.post('/api/products', (req,res)=>{ try{ok(res,db.addProduct(req.body))}catch(e){fail(res,e)}});
app.put('/api/products/:id', (req,res)=>{ try{ok(res,db.updateProduct(Number(req.params.id),req.body))}catch(e){fail(res,e)}});
app.delete('/api/products/:id', (req,res)=>{ try{ok(res,db.deleteProduct(Number(req.params.id)))}catch(e){fail(res,e)}});

// 客户
app.get('/api/customers', (req,res)=>{ try{ok(res,db.listCustomers(req.query))}catch(e){fail(res,e)} });
app.get('/api/customers/:id', (req,res)=>{
  try{ const c = db.getCustomer(Number(req.params.id)); if(!c) return fail(res,new Error('客户不存在'),404); ok(res,c); }catch(e){fail(res,e)}
});
app.post('/api/customers', (req,res)=>{ try{ok(res,db.addCustomer(req.body))}catch(e){fail(res,e)} });
app.put('/api/customers/:id', (req,res)=>{ try{ok(res,db.updateCustomer(Number(req.params.id),req.body))}catch(e){fail(res,e)} });
app.delete('/api/customers/:id', (req,res)=>{ try{ok(res,db.deleteCustomer(Number(req.params.id)))}catch(e){fail(res,e)} });

// 供应商
app.get('/api/suppliers', (req,res)=>{ try{ok(res,db.listSuppliers(req.query))}catch(e){fail(res,e)} });
app.get('/api/suppliers/:id', (req,res)=>{ try{ const s=db.getSupplier(Number(req.params.id)); if(!s) return fail(res,new Error('供应商不存在'),404); ok(res,s); }catch(e){fail(res,e)} });
app.post('/api/suppliers', (req,res)=>{ try{ok(res,db.addSupplier(req.body))}catch(e){fail(res,e)} });
app.put('/api/suppliers/:id', (req,res)=>{ try{ok(res,db.updateSupplier(Number(req.params.id),req.body))}catch(e){fail(res,e)} });
app.delete('/api/suppliers/:id', (req,res)=>{ try{ok(res,db.deleteSupplier(Number(req.params.id)))}catch(e){fail(res,e)} });

app.post('/api/stock/in', (req,res)=>{
  try{const{product_id,quantity,operator,remark,supplier_id,specification,material,unit,unit_price,price}=req.body; ok(res,db.stockIn(product_id,quantity,operator,remark,supplier_id,{specification,material,unit,unit_price,price}))}catch(e){fail(res,e)}
});
app.post('/api/stock/out', (req,res)=>{
  try{const{product_id,quantity,operator,remark,customer_id,specification,material,unit,unit_price,price}=req.body; ok(res,db.stockOut(product_id,quantity,operator,remark,customer_id,{specification,material,unit,unit_price,price}))}catch(e){fail(res,e)}
});
app.get('/api/transactions', (req,res)=>{ try{ok(res,db.listTx(req.query))}catch(e){fail(res,e)}});
app.delete('/api/transactions/:id', (req,res)=>{ try{ok(res,db.deleteTransaction(Number(req.params.id)))}catch(e){fail(res,e)}});
app.get('/api/orders',(req,res)=>{try{ok(res,db.listOrders())}catch(e){fail(res,e)}});
app.post('/api/orders',(req,res)=>{try{ok(res,db.addOrder(req.body))}catch(e){fail(res,e)}});
app.put('/api/orders/:id',(req,res)=>{try{ok(res,db.updateOrder(Number(req.params.id),req.body))}catch(e){fail(res,e)}});
app.get('/api/ledger', (req,res)=>{ try{ok(res,db.listLedger(req.query))}catch(e){fail(res,e)}});
app.post('/api/ledger', (req,res)=>{ try{ok(res,db.addLedger(req.body))}catch(e){fail(res,e)}});
app.delete('/api/ledger/:id', (req,res)=>{ try{ok(res,db.deleteLedger(Number(req.params.id)))}catch(e){fail(res,e)}});

// 获取本机局域网 IP
function getLanIP() {
  const ifaces = os.networkInterfaces();
  for (const name of Object.keys(ifaces)) {
    for (const iface of ifaces[name]) {
      if (iface.family === 'IPv4' && !iface.internal) {
        return iface.address;
      }
    }
  }
  return '127.0.0.1';
}

app.listen(PORT, '0.0.0.0', ()=>{
  const lanIP = getLanIP();
  console.log(`\n  ============================================`);
  console.log(`  仓库出入库管理系统（无扫码版）已启动`);
  console.log(`  电脑本地: http://localhost:${PORT}`);
  console.log(`  手机访问: http://${lanIP}:${PORT}  （手机与电脑连同一WiFi）`);
  console.log(`  操作方式: 从下拉列表选择商品即可出入库`);
  console.log(`  ============================================\n`);
});
