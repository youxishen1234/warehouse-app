const fs = require('node:fs');
const path = require('node:path');
const QRCode = require('qrcode');

const TOKEN = /^[a-f0-9]{64}$/;
const ORIGIN = 'https://youxishen.online';

function pairingToken(value) {
  const input = String(value || '').trim();
  if (TOKEN.test(input)) return input;
  try {
    const url = new URL(input, ORIGIN);
    const hashQuery = url.hash.includes('?') ? url.hash.slice(url.hash.indexOf('?') + 1) : '';
    const candidate = url.searchParams.get('print_pair') || new URLSearchParams(hashQuery).get('print_pair') || '';
    return TOKEN.test(candidate) ? candidate : '';
  } catch {
    return '';
  }
}

async function createPairCard(input, output) {
  const token = pairingToken(input);
  if (!token) throw new Error('连接凭据无效');
  const target = path.resolve(output);
  const pairingLink = `${ORIGIN}/#/pages/print-center/index?print_pair=${token}`;
  const image = await QRCode.toDataURL(pairingLink, {
    errorCorrectionLevel: 'M',
    margin: 4,
    width: 640,
    color: { dark: '#111111ff', light: '#ffffffff' }
  });
  const html = `<!doctype html>
<html lang="zh-CN">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width,initial-scale=1">
  <meta name="robots" content="noindex,nofollow">
  <title>连接手机打印</title>
  <style>
    *{box-sizing:border-box}body{margin:0;min-height:100vh;display:grid;place-items:center;background:#f4f1ea;color:#171714;font:16px/1.5 "Microsoft YaHei",sans-serif}
    main{width:min(92vw,620px);padding:32px;text-align:center;background:#fff;border:1px solid #d8d2c6;border-radius:8px}
    h1{margin:0 0 8px;font-size:28px}p{margin:0 0 24px;color:#625e55}img{display:block;width:min(100%,520px);height:auto;margin:auto}
  </style>
</head>
<body><main><h1>手机扫码连接打印电脑</h1><p>请使用仓库 App 扫描下方二维码</p><img alt="打印电脑连接二维码" src="${image}"></main></body>
</html>`;
  fs.mkdirSync(path.dirname(target), { recursive: true });
  const temporary = target + '.tmp-' + process.pid;
  try {
    fs.writeFileSync(temporary, html, { mode: 0o600 });
    fs.renameSync(temporary, target);
  } finally {
    if (fs.existsSync(temporary)) fs.unlinkSync(temporary);
  }
  return target;
}

async function main() {
  const input = process.argv[2];
  if (!input) throw new Error('用法：node scripts/remote-print-pair-card.cjs <连接凭据> [输出文件]');
  const output = await createPairCard(input, process.argv[3] || 'remote-print-pair.html');
  console.log('已生成连接二维码：' + output);
}

if (require.main === module) main().catch(error => {
  console.error(error.message);
  process.exitCode = 1;
});

module.exports = { pairingToken, createPairCard };
