const QRCode = require('qrcode');
const { registerPlugin } = require('@capacitor/core');
const NiimbotPrinter = registerPlugin('NiimbotPrinter');
const Protocol = require('./niimbot-protocol');
const keys = ['name', 'company', 'goods', 'specification', 'unit', 'quantity'];
const form = document.querySelector('form');
const params = new URLSearchParams(location.hash.slice(1));
const readOnly = params.get('view') === '1';
const native = new URLSearchParams(location.search).get('client') === 'app';
const nativeBluetooth = native && typeof window !== 'undefined' && Boolean(window.Capacitor && window.Capacitor.isNativePlatform && window.Capacitor.isNativePlatform());
const NativePrinterAPI = nativeBluetooth && window.Capacitor.Plugins && window.Capacitor.Plugins.NiimbotPrinter
  ? window.Capacitor.Plugins.NiimbotPrinter
  : NiimbotPrinter;
const width = ['50', '70', '80'].includes(params.get('width')) ? Number(params.get('width')) : 70;
document.body.dataset.width = String(width);
document.body.classList.add('label-paper');
document.querySelector('#size-note').textContent = width + ' × 100 mm · 黑白标签';
const pageStyle = document.createElement('style');
pageStyle.textContent = '@page { size: ' + width + 'mm 100mm; margin: 0; }';
document.head.appendChild(pageStyle);
window.addEventListener('hashchange', () => location.reload());
if (readOnly) document.body.classList.add('view');
keys.forEach(key => { if (params.has(key)) form.elements[key].value = params.get(key); });
if (!['成品', '纸板'].includes(form.elements.name.value)) form.elements.name.value = '成品';
if (!params.has('unit')) form.elements.unit.value = form.elements.name.value === '纸板' ? '张' : '个';
let sequence = 0;
async function update() {
  const current = ++sequence;
  const data = Object.fromEntries(keys.map(key => [key, form.elements[key].value.trim()]));
  document.querySelectorAll('[data-label-kind]').forEach(button => {
    button.setAttribute('aria-pressed', String(button.dataset.labelKind === data.name));
  });
  keys.forEach(key => { document.querySelector('[data-field="' + key + '"]').textContent = data[key] || '未填写'; });
  const goodsRow = document.querySelector('[data-field="goods"]').closest('.row');
  goodsRow.hidden = !data.goods;
  goodsRow.style.display = data.goods ? '' : 'none';
  document.querySelector('#amount').textContent = (data.quantity || '未填写') + ' ' + data.unit;
  document.querySelector('#label-title').textContent = '曙光仓库 · ' + data.name + '标签';
  const hash = new URLSearchParams({ view: '1', width: String(width), ...data });
  const labelUrl = native ? 'https://youxishen.online/spec-test.html' : location.origin + location.pathname;
  const link = labelUrl + '#' + hash.toString();
  try {
    document.querySelector('#qr').removeAttribute('src');
    const qr = await QRCode.toDataURL(link, { width: 900, margin: 4, errorCorrectionLevel: 'M', color: { dark: '#000000', light: '#ffffff' } });
    if (current === sequence) { document.querySelector('#qr').src = qr; document.querySelector('#status').textContent = ''; }
  } catch (_) { document.querySelector('#status').textContent = '内容过长，无法生成二维码，请缩短填写内容。'; }
}
form.addEventListener('input', update);
form.elements.name.addEventListener('change', () => { form.elements.unit.value = form.elements.name.value === '纸板' ? '张' : '个'; update(); });
document.querySelectorAll('[data-label-kind]').forEach(button => {
  button.addEventListener('click', () => {
    if (form.elements.name.value === button.dataset.labelKind) return;
    form.elements.name.value = button.dataset.labelKind;
    form.elements.name.dispatchEvent(new Event('change'));
  });
});

const back = document.querySelector('#back');
if (document.referrer && new URL(document.referrer).pathname.endsWith('/customer-desk.html')) back.textContent = '返回尺寸本';
back.addEventListener('click', () => {
  if (history.length > 1) history.back();
  else location.href = './index.html#/pages/home/index';
});

let printerConnected = false;
let printerBuffer = [];
const printerTools = document.querySelector('#printer-tools');
const printerSelect = document.querySelector('#printer-device');
const printerStatus = document.querySelector('#printer-status');
const connectButton = document.querySelector('#printer-connect');
const directPrintButton = document.querySelector('#direct-print');
const pendingPrinterReplies = new Map();

function setPrinterStatus(message) { printerStatus.textContent = message; }
function resolvePrinterReplies(bytes) {
  const parsed = Protocol.parsePackets([...printerBuffer, ...bytes]);
  printerBuffer = parsed.rest;
  for (const incoming of parsed.packets) {
    const pending = pendingPrinterReplies.get(incoming.command);
    if (pending) {
      clearTimeout(pending.timer);
      pendingPrinterReplies.delete(incoming.command);
      pending.resolve(incoming);
    }
  }
}

async function sendPrinterBytes(bytes, type = 'command') {
  await NativePrinterAPI.write({ data: bytes, type: type === 'command' ? 'response' : 'fast' });
}

function waitForPrinterReply(command, timeout = 4000) {
  if (pendingPrinterReplies.has(command)) throw new Error('打印机正在处理其他命令，请稍候');
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      pendingPrinterReplies.delete(command);
      reject(new Error('打印机响应超时，请确认标签机已开机并装好标签纸'));
    }, timeout);
    pendingPrinterReplies.set(command, { resolve, reject, timer });
  });
}

async function sendPrinterCommand(command, payload, response, timeout) {
  const waiting = waitForPrinterReply(response, timeout);
  await sendPrinterBytes(Protocol.packet(command, payload), 'command');
  return waiting;
}

function infoValue(packet) { return packet.data.length ? packet.data[packet.data.length - 1] : 0; }

async function identifyK3() {
  const modelInfo = await sendPrinterCommand(0x40, [0x08], 0x48);
  if (modelInfo.data.length < 2) throw new Error('打印机没有返回型号，请重新连接');
  const tail = modelInfo.data.slice(-2);
  const model = (tail[0] << 8) | tail[1];
  const reverseModel = (tail[1] << 8) | tail[0];
  if (!Protocol.K3_MODEL_IDS.includes(model) && !Protocol.K3_MODEL_IDS.includes(reverseModel)) {
    throw new Error('检测到打印机型号 ' + (Protocol.K3_MODEL_IDS.includes(reverseModel) ? reverseModel : model) + '，目前仅接入精臣 K3');
  }
  return { model: Protocol.K3_MODEL_IDS.includes(model) ? model : reverseModel };
}

async function connectK3() {
  if (!nativeBluetooth) throw new Error('蓝牙直打需要安装带精臣蓝牙功能的 iPhone App 版本');
  printerTools.hidden = false;
  setPrinterStatus('正在搜索附近的精臣标签机…');
  const result = await NativePrinterAPI.scan();
  const devices = result.devices || [];
  printerSelect.replaceChildren();
  for (const device of devices) {
    const option = document.createElement('option');
    option.value = device.id;
    option.textContent = device.name;
    printerSelect.appendChild(option);
  }
  if (!devices.length) throw new Error('没有找到打印机。请开机、靠近 iPhone，并断开其他手机的连接后重试。');
  setPrinterStatus('找到 ' + devices.length + ' 台设备，请选择打印机并点“连接”。');
  connectButton.disabled = false;
}

async function pairK3() {
  const id = printerSelect.value;
  if (!id) throw new Error('请先搜索并选择精臣 K3');
  connectButton.disabled = true;
  setPrinterStatus('正在连接标签机…');
  await NativePrinterAPI.connect({ id });
  printerBuffer = [];
  const handshake = waitForPrinterReply(0xc2, 2500);
  await sendPrinterBytes(Protocol.connectPacket(), 'command');
  await handshake;
  const identified = await identifyK3();
  printerConnected = true;
  directPrintButton.disabled = false;
  setPrinterStatus('已连接精臣 K3（型号 ' + identified.model + '），可以蓝牙直打。');
}

async function labelCanvas() {
  const canvas = document.createElement('canvas');
  canvas.width = Protocol.LABEL_WIDTH_PIXELS;
  canvas.height = Protocol.LABEL_HEIGHT_PIXELS;
  const context = canvas.getContext('2d', { willReadFrequently: true });
  context.fillStyle = '#fff';
  context.fillRect(0, 0, canvas.width, canvas.height);
  context.fillStyle = '#000';
  context.textAlign = 'center';
  context.textBaseline = 'top';
  const name = form.elements.name.value.trim();
  const company = form.elements.company.value.trim();
  const goods = form.elements.goods.value.trim();
  const spec = form.elements.specification.value.trim();
  const unit = form.elements.unit.value.trim();
  const quantity = form.elements.quantity.value.trim();
  const wrap = (text, maxWidth, font) => {
    context.font = font;
    const lines = [];
    let line = '';
    for (const character of Array.from(text)) {
      const next = line + character;
      if (line && context.measureText(next).width > maxWidth) { lines.push(line); line = character; }
      else line = next;
    }
    if (line) lines.push(line);
    return lines.slice(0, 2);
  };
  context.font = 'bold 26px sans-serif';
  context.fillText('曙光仓库 · ' + name + '标签', 280, 26, 520);
  context.font = '16px sans-serif';
  context.fillText('规格', 280, 69);
  const specLines = wrap(spec, 510, 'bold 27px sans-serif');
  context.font = 'bold 27px sans-serif';
  specLines.forEach((line, index) => context.fillText(line, 280, 94 + index * 32, 510));
  const qr = document.querySelector('#qr');
  await qr.decode();
  const qrSize = 224;
  const qrY = 154 + Math.max(0, specLines.length - 1) * 29;
  context.imageSmoothingEnabled = false;
  context.drawImage(qr, 168, qrY, qrSize, qrSize);
  context.imageSmoothingEnabled = true;
  context.font = '16px sans-serif';
  const hintY = qrY + qrSize + 13;
  context.fillText('扫一扫 · 查看货物资料', 280, hintY);
  context.font = 'bold 30px sans-serif';
  context.fillText(quantity + ' ' + unit, 280, hintY + 30, 520);
  const details = [['公司', company], ['货物', goods], ['单位', unit], ['数量', quantity]]
    .filter(([label, value]) => label !== '货物' || value);
  context.textAlign = 'left';
  context.font = '16px sans-serif';
  details.forEach(([label, value], index) => {
    const y = hintY + 91 + index * 39;
    context.fillText(label, 25, y);
    const lines = wrap(value, 390, 'bold 16px sans-serif');
    context.font = 'bold 16px sans-serif';
    lines.forEach((line, row) => context.fillText(line, 125, y + row * 19, 410));
    context.font = '16px sans-serif';
    context.fillRect(25, y + 31, 510, 1);
  });
  context.textAlign = 'center';
  context.font = '12px sans-serif';
  context.fillText('曙光仓库 · 货物规格标签', 280, 750);
  context.fillText('标签仅用于货物识别，不产生出入库记录。', 280, 770);
  return canvas;
}

const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));

async function printK3() {
  if (!printerConnected) throw new Error('请先连接精臣 K3');
  if (!form.checkValidity()) throw new Error('请先填写公司、规格和有效数量');
  directPrintButton.disabled = true;
  setPrinterStatus('正在生成 70 × 100 mm 标签…');
  try {
    const canvas = await labelCanvas();
    const rows = Protocol.canvasToRows(canvas);
    if (canvas.width > Protocol.K3_HEAD_PIXELS) throw new Error('标签宽度超出 K3 打印头范围');
    const modelInfo = await sendPrinterCommand(0x40, [0x08], 0x48);
    const rawId = modelInfo.data.slice(-2);
    const modelId = (rawId[0] << 8) | rawId[1];
    const normalizedModel = Protocol.K3_MODEL_IDS.includes(modelId) ? modelId : (rawId[1] << 8) | rawId[0];
    if (!Protocol.K3_MODEL_IDS.includes(normalizedModel)) throw new Error('连接的设备不是精臣 K3');
    let density = 3;
    try { density = infoValue(await sendPrinterCommand(0x40, [0x01], 0x48)); } catch (_) { /* K3 factory default */ }
    await sendPrinterCommand(0x21, [density], 0x31);
    await sendPrinterCommand(0x23, [0x01], 0x33);
    await sendPrinterCommand(0x20, [0x01], 0x30);
    await sendPrinterCommand(0x01, [0x00, 0x01, 0x00, 0x00, 0x00, 0x00, 0x00], 0x21);
    await sendPrinterCommand(0x03, [0x01], 0x23);
    await sendPrinterCommand(0x13, [0x03, 0x20, 0x02, 0x30, 0x00, 0x01], 0x33);
    setPrinterStatus('标签已发送：0 / ' + rows.length + ' 行');
    for (let index = 0; index < rows.length; index++) {
      await sendPrinterBytes(Protocol.encodeRow(rows[index], index), (index + 1) % 16 === 0 ? 'command' : 'fast');
      if ((index + 1) % 40 === 0) {
        setPrinterStatus('标签发送中：' + (index + 1) + ' / ' + rows.length + ' 行');
        await sleep(20);
      }
    }
    await sendPrinterCommand(0xe3, [0x01], 0xe4, 12000);
    setPrinterStatus('打印机正在输出标签…');
    for (let attempt = 0; attempt < 24; attempt++) {
      const result = await sendPrinterCommand(0xf3, [0x01], 0xf4, 8000);
      if (result.data[result.data.length - 1] === 1) {
        setPrinterStatus('标签打印完成。');
        return;
      }
      await sleep(500);
    }
    throw new Error('打印任务仍未完成，请检查标签纸是否卡住');
  } finally {
    directPrintButton.disabled = !printerConnected;
  }
}

if (nativeBluetooth) {
  printerTools.hidden = false;
  NativePrinterAPI.addListener('data', event => resolvePrinterReplies(event.bytes || []));
  NativePrinterAPI.addListener('disconnected', () => {
    printerConnected = false;
    connectButton.disabled = false;
    directPrintButton.disabled = true;
    setPrinterStatus('打印机已断开，请重新连接。');
  });
  document.querySelector('#printer-scan').addEventListener('click', async () => {
    connectButton.disabled = true;
    directPrintButton.disabled = true;
    try { await connectK3(); } catch (error) { setPrinterStatus(error.message || '搜索打印机失败'); }
  });
  connectButton.addEventListener('click', async () => {
    try { await pairK3(); } catch (error) { printerConnected = false; connectButton.disabled = false; setPrinterStatus(error.message || '连接打印机失败'); }
  });
  directPrintButton.addEventListener('click', async () => {
    try { await printK3(); } catch (error) { setPrinterStatus(error.message || '打印失败'); }
  });
}

document.querySelector('#print').addEventListener('click', async () => {
  if (!form.checkValidity()) { alert('请填写公司、规格和有效数量。货物名称可以留空。'); return; }
  if (!document.querySelector('#qr').src || document.querySelector('#status').textContent) return;
  {
    const label = document.querySelector('.label');
    if (label.scrollHeight > label.clientHeight + 1) { alert('标签内容超出当前纸张，请缩短文字后打印。'); return; }
  }
  const current = sequence;
  try { await document.querySelector('#qr').decode(); } catch (_) { return; }
  if (current !== sequence) return;
  if (typeof window.print !== 'function') {
    document.querySelector('#status').textContent = '请在电脑或支持打印的浏览器中打开标签打印。';
    return;
  }
  window.print();
});
update();
