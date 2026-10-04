const QRCode = require('qrcode');
const { registerPlugin } = require('@capacitor/core');
const NiimbotPrinter = registerPlugin('NiimbotPrinter');
const Protocol = require('./niimbot-protocol');
const keys = ['name', 'company', 'goods', 'specification', 'unit', 'quantity'];
const form = document.querySelector('form');
const params = new URLSearchParams(location.hash.slice(1));
const readOnly = params.get('view') === '1';
const native = new URLSearchParams(location.search).get('client') === 'app';
const nativeBluetooth = native && typeof window !== 'undefined' && Boolean(
  window.Capacitor &&
  window.Capacitor.isNativePlatform &&
  window.Capacitor.isNativePlatform() &&
  (typeof window.Capacitor.isPluginAvailable !== 'function' || window.Capacitor.isPluginAvailable('NiimbotPrinter'))
);
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
let printerBusy = false;
let jobActive = false;
let completedPage = 0;
let jobError = null;
const printerTools = document.querySelector('#printer-tools');
const printerSelect = document.querySelector('#printer-device');
const printerStatus = document.querySelector('#printer-status');
const connectButton = document.querySelector('#printer-connect');
const directPrintButton = document.querySelector('#direct-print');
const scanButton = document.querySelector('#printer-scan');
const pendingPrinterReplies = new Map();
let listenersReady = Promise.resolve();

function setPrinterStatus(message) { printerStatus.textContent = message; }
function rejectPrinterReplies(error) {
  for (const pending of pendingPrinterReplies.values()) {
    clearTimeout(pending.timer);
    pending.reject(error);
  }
  pendingPrinterReplies.clear();
}

function resolvePrinterReplies(bytes) {
  const parsed = Protocol.parsePackets([...printerBuffer, ...bytes]);
  printerBuffer = parsed.rest;
  for (const incoming of parsed.packets) {
    if (incoming.command === 0xdb) {
      const errors = { 1: '打印机上盖未关', 2: '打印机缺纸', 3: '打印机电量不足', 5: '打印已取消', 6: '打印机拒绝标签数据' };
      jobError = new Error(errors[incoming.data[0]] || '打印机错误：' + incoming.data[0]);
      rejectPrinterReplies(jobError);
      setPrinterStatus(jobError.message);
      continue;
    }
    if (incoming.command === 0xe0 && jobActive && incoming.data.length >= 2) {
      completedPage = Math.max(completedPage, Protocol.asUInt16(incoming.data));
    }
    const pending = pendingPrinterReplies.get(incoming.command);
    if (pending) {
      clearTimeout(pending.timer);
      pendingPrinterReplies.delete(incoming.command);
      pending.resolve(incoming);
    }
  }
}

async function sendPrinterBytes(bytes, type = 'command') {
  if (jobError) throw jobError;
  await NativePrinterAPI.write({ data: bytes, type: type === 'command' ? 'response' : 'fast' });
}

function waitForPrinterReply(command, timeout = 4000) {
  if (pendingPrinterReplies.has(command)) throw new Error('打印机正在处理其他命令，请稍候');
  const waiting = new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      pendingPrinterReplies.delete(command);
      reject(new Error('打印机响应超时，请确认标签机已开机并装好标签纸'));
    }, timeout);
    pendingPrinterReplies.set(command, { resolve, reject, timer });
  });
  // Native writes can still be pending when a notification rejects the wait.
  waiting.catch(() => {});
  return waiting;
}

async function sendPrinterCommand(command, payload, response, timeout, prefixed = false) {
  const waiting = waitForPrinterReply(response, timeout);
  try {
    await sendPrinterBytes(prefixed ? Protocol.connectPacket() : Protocol.packet(command, payload), 'command');
    return await waiting;
  } catch (error) {
    const pending = pendingPrinterReplies.get(response);
    if (pending) {
      clearTimeout(pending.timer);
      pendingPrinterReplies.delete(response);
    }
    throw error;
  }
}

async function checkedPrinterCommand(command, payload, response, timeout) {
  const reply = await sendPrinterCommand(command, payload, response, timeout);
  if (reply.data[0] !== 1) throw new Error('打印机拒绝命令 0x' + command.toString(16));
  return reply;
}

function infoValue(packet) { return packet.data.length ? packet.data[packet.data.length - 1] : 0; }

async function identifyK3() {
  const modelInfo = await sendPrinterCommand(0x40, [0x08], 0x48);
  const model = Protocol.modelId(modelInfo.data);
  if (!Protocol.K3_MODEL_IDS.includes(model)) {
    throw new Error('检测到打印机型号 ' + model + '，目前仅接入精臣 K3');
  }
  return { model };
}

async function connectK3() {
  if (!nativeBluetooth) throw new Error('蓝牙直打需要安装带精臣蓝牙功能的 iPhone App 版本');
  await listenersReady;
  if (printerConnected) await NativePrinterAPI.disconnect();
  printerConnected = false;
  jobError = null;
  printerSelect.replaceChildren();
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
  jobError = null;
  const handshake = await sendPrinterCommand(0xc1, [1], 0xc2, 4000, true);
  if (![1, 2, 3].includes(handshake.data[0])) throw new Error('打印机拒绝蓝牙握手，请关闭精臣软件后重试');
  const identified = await identifyK3();
  printerConnected = true;
  setPrinterStatus('已连接精臣 K3（型号 ' + identified.model + '）。');
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
    if (lines.length > 2) throw new Error('标签文字过长，请缩短后打印');
    return lines;
  };
  context.font = 'bold 26px sans-serif';
  context.fillText('曙光仓库 · ' + name + '标签', 280, 26, 520);
  context.font = '16px sans-serif';
  context.fillText('规格', 280, 69);
  const specLines = wrap(spec, 510, 'bold 27px sans-serif');
  context.font = 'bold 27px sans-serif';
  specLines.forEach((line, index) => context.fillText(line, 280, 94 + index * 32, 510));
  const qrParams = new URLSearchParams({ view: '1', width: String(width), ...Object.fromEntries(keys.map(key => [key, form.elements[key].value.trim()])) });
  const qrLink = 'https://youxishen.online/spec-test.html#' + qrParams;
  const modules = QRCode.create(qrLink, { errorCorrectionLevel: 'M' }).modules.size;
  const qrScale = Math.floor(264 / (modules + 8));
  if (qrScale < 2) throw new Error('标签资料太长，二维码过密，请缩短文字');
  const qr = await QRCode.toCanvas(qrLink, { scale: qrScale, margin: 4, errorCorrectionLevel: 'M' });
  const qrSize = qr.width;
  const qrY = 154 + Math.max(0, specLines.length - 1) * 29;
  context.imageSmoothingEnabled = false;
  context.drawImage(qr, Math.floor((canvas.width - qrSize) / 2), qrY);
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
  let y = hintY + 83;
  details.forEach(([label, value]) => {
    const lines = wrap(value, 390, 'bold 16px sans-serif');
    const rowHeight = Math.max(35, lines.length * 19 + 12);
    if (y + rowHeight > 736) throw new Error('标签内容超出纸张，请缩短文字');
    context.fillText(label, 25, y);
    context.font = 'bold 16px sans-serif';
    lines.forEach((line, row) => context.fillText(line, 125, y + row * 19, 410));
    context.font = '16px sans-serif';
    context.fillRect(25, y + rowHeight - 5, 510, 1);
    y += rowHeight;
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
  if (width !== 70) throw new Error('K3 蓝牙打印目前仅支持 70 × 100 mm 标签');
  const quantity = Number(form.elements.quantity.value);
  if (!form.elements.company.value.trim() || !form.elements.specification.value.trim() ||
      !Number.isSafeInteger(quantity) || quantity <= 0) throw new Error('请先填写公司、规格和有效数量');
  jobError = null;
  completedPage = 0;
  setPrinterStatus('正在生成 70 × 100 mm 标签…');
  try {
    await update();
    await document.fonts.ready;
    const canvas = await labelCanvas();
    const rows = Protocol.canvasToRows(canvas);
    if (canvas.width > Protocol.K3_HEAD_PIXELS) throw new Error('标签宽度超出 K3 打印头范围');
    await identifyK3();
    let density = 3;
    const densityInfo = infoValue(await sendPrinterCommand(0x40, [0x01], 0x41));
    if (densityInfo >= 1 && densityInfo <= 5) density = densityInfo;
    await checkedPrinterCommand(0x21, [density], 0x31);
    await checkedPrinterCommand(0x23, [0x01], 0x33);
    jobActive = true;
    await checkedPrinterCommand(0x01, [0x00, 0x01, 0x00, 0x00, 0x00, 0x00, 0x00], 0x02);
    await checkedPrinterCommand(0x03, [0x01], 0x04);
    await checkedPrinterCommand(0x13, [0x03, 0x20, 0x02, 0x30, 0x00, 0x01], 0x14);
    const initial = Protocol.printStatus((await sendPrinterCommand(0xa3, [1], 0xb3)).data);
    let started = initial.page === 0 || initial.printProgress < 100;
    setPrinterStatus('标签已发送：0 / ' + rows.length + ' 行');
    for (let index = 0; index < rows.length; index++) {
      await sendPrinterBytes(Protocol.encodeRow(rows[index], index), (index + 1) % 16 === 0 ? 'command' : 'fast');
      if ((index + 1) % 200 === 0) await sendPrinterCommand(0x86, [(index + 1) >>> 8, (index + 1) & 255, 1], 0xd3);
      if ((index + 1) % 40 === 0) {
        setPrinterStatus('标签发送中：' + (index + 1) + ' / ' + rows.length + ' 行');
        await sleep(20);
      }
    }
    await checkedPrinterCommand(0xe3, [0x01], 0xe4, 12000);
    setPrinterStatus('打印机正在输出标签…');
    const deadline = Date.now() + 60000;
    while (Date.now() < deadline) {
      if (completedPage >= 1) break;
      const result = await sendPrinterCommand(0xa3, [0x01], 0xb3, 8000);
      const status = Protocol.printStatus(result.data);
      if (status.page === 0 || status.printProgress < 100) started = true;
      if (started && status.page >= 1 && status.printProgress >= 100 && status.feedProgress >= 100) {
        completedPage = status.page;
        break;
      }
      await sleep(500);
    }
    if (completedPage < 1) throw new Error('未确认标签输出完成，请检查标签纸后重新连接');
    await checkedPrinterCommand(0xf3, [0x01], 0xf4, 8000);
    setPrinterStatus('打印机已确认完成，请检查标签和二维码。');
  } catch (error) {
    if (jobActive && printerConnected) {
      try { await NativePrinterAPI.write({ data: Protocol.packet(0xda, [1]), type: 'response' }); } catch (_) { /* Disconnect below clears a failed job. */ }
      try { await NativePrinterAPI.disconnect(); } catch (_) { /* Already disconnected. */ }
      printerConnected = false;
    }
    throw error;
  } finally {
    jobActive = false;
  }
}

function syncPrinterButtons() {
  scanButton.disabled = printerBusy;
  connectButton.disabled = printerBusy || !printerSelect.value;
  printerSelect.disabled = printerBusy;
  directPrintButton.disabled = printerBusy || !printerConnected;
  form.querySelectorAll('input,select').forEach(input => { input.disabled = printerBusy; });
  document.querySelectorAll('[data-label-kind]').forEach(button => { button.disabled = printerBusy; });
}

async function runPrinterAction(action) {
  if (printerBusy) return;
  printerBusy = true;
  syncPrinterButtons();
  try {
    await listenersReady;
    await action();
  } catch (error) {
    setPrinterStatus(error.message || '打印机操作失败');
  } finally {
    printerBusy = false;
    syncPrinterButtons();
  }
}

if (nativeBluetooth) {
  printerTools.hidden = false;
  listenersReady = Promise.all([
    NativePrinterAPI.addListener('data', event => resolvePrinterReplies(event.bytes || [])),
    NativePrinterAPI.addListener('disconnected', () => {
      printerConnected = false;
      jobError = new Error('打印机已断开，请重新连接。');
      rejectPrinterReplies(jobError);
      printerBuffer = [];
      syncPrinterButtons();
      setPrinterStatus(jobError.message);
    }),
  ]).catch(error => {
    printerTools.hidden = true;
    document.querySelector('#status').textContent = '蓝牙打印不可用，请安装新版 iOS App。';
    throw error;
  });
  listenersReady.catch(() => {});
  scanButton.addEventListener('click', () => runPrinterAction(connectK3));
  connectButton.addEventListener('click', () => runPrinterAction(async () => {
    try { await pairK3(); } catch (error) {
      printerConnected = false;
      try { await NativePrinterAPI.disconnect(); } catch (_) { /* Already disconnected. */ }
      throw error;
    }
  }));
  directPrintButton.addEventListener('click', () => runPrinterAction(printK3));
  printerSelect.addEventListener('change', () => runPrinterAction(async () => {
    await NativePrinterAPI.disconnect();
    printerConnected = false;
    jobError = null;
    setPrinterStatus('请选择打印机并连接。');
  }));
  window.addEventListener('pagehide', () => {
    rejectPrinterReplies(new Error('已离开标签页面'));
    NativePrinterAPI.disconnect().catch(() => {});
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
