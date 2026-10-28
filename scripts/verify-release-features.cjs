const fs = require('node:fs');
const path = require('node:path');
const root = path.resolve(process.argv[2] || 'dist');
const scripts = fs.readdirSync(path.join(root, 'js')).filter(name => name.endsWith('.js'));
const content = scripts.map(name => fs.readFileSync(path.join(root, 'js', name), 'utf8')).join('\n');
for (const marker of ['pages/business-center/index', '流水明细', '单据凭证', 'pages/orders/index', 'pages/outbound/index', 'simple-workbench', 'workbench-actions', '业务总台', '纸板入库', '纸箱入库', '规格与订单', '客户账单', '供货商账单', '电脑 USB 打印 K3', '手机不连接蓝牙', 'remote-print/labels/']) {
  if (!content.includes(marker)) throw new Error('Release is missing required feature: ' + marker);
}
console.log('Required feature contracts passed.');
