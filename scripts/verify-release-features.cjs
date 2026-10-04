const fs = require('node:fs');
const path = require('node:path');
const root = path.resolve(process.argv[2] || 'dist');
const scripts = fs.readdirSync(path.join(root, 'js')).filter(name => name.endsWith('.js'));
const content = scripts.map(name => fs.readFileSync(path.join(root, 'js', name), 'utf8')).join('\n');
for (const marker of ['pages/ledger/index', '流水明细', '单据凭证', 'pages/orders/index', 'pages/customer-edit/index', 'pages/outbound/index']) {
  if (!content.includes(marker)) throw new Error('Release is missing required feature: ' + marker);
}
for (const name of ['customer-desk.html', 'customer-desk.js', 'customer-dock.js', 'spec-test.html', 'spec-label.js']) {
  if (!fs.existsSync(path.join(root, name))) throw new Error('Release is missing standalone feature: ' + name);
}
console.log('Required feature contracts passed.');
