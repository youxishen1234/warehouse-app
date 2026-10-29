const fs = require('node:fs');
const path = require('node:path');
const root = path.resolve(process.argv[2] || 'dist');
function files(directory) {
  return fs.readdirSync(directory, { withFileTypes: true }).flatMap(entry => {
    const filename = path.join(directory, entry.name);
    return entry.isDirectory() ? files(filename) : [filename];
  });
}
const content = files(root)
  .filter(filename => /\.(?:js|html|css)$/.test(filename))
  .map(filename => fs.readFileSync(filename, 'utf8'))
  .join('\n');
for (const marker of [
  'pages/home/index',
  'pages/customers/index',
  'pages/inventory/index',
  'pages/finance/index',
  'pages/suppliers/index',
  'pages/print-center/index',
  '业务总台',
  '客户管理',
  '收付款',
  '供货商',
  '打印中心',
  'dimension-input.js',
  '货名或规格输入'
]) {
  if (!content.includes(marker)) throw new Error('Release is missing required feature: ' + marker);
}
for (const retired of [
  'pages/ai-assistant/index',
  'pages/business-center/index',
  'pages/label-print/index',
  'pages/label-resolver/index',
  'pages/board-calculator/index',
  'pages/board-receive/index',
  'pages/board-detail/index',
  'pages/board-scan/index',
  'pages/board-outbound/index',
  'pages/inbound/index',
  'pages/outbound/index',
  'pages/mine/index',
  'pages/products/index',
  'pages/records/index',
  'pages/orders/index',
  'pages/team/index',
  'pages/customer-edit/index',
  'pages/custom-copy/index',
  'pages/backup/index',
  'pages/customer-photos/index',
  'pages/carton-calculator/index',
  'pages/ledger/index',
  'pages/board-stock/index'
]) {
  if (content.includes(retired)) throw new Error('Release still contains retired route: ' + retired);
}
console.log('Six-view demo feature contracts passed.');
