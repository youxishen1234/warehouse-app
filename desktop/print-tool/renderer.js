/* global desktopPrint */
const byId = id => document.getElementById(id);
let sequence = 0, busy = false, previewSequence = 0;
let printers = [];
const printerPreference = 'warehouse_desktop_printer_v1';
function preferredPrinter() { try { return localStorage.getItem(printerPreference) || ''; } catch { return ''; } }
function rememberPrinter(name) { try { localStorage.setItem(printerPreference, name); } catch { /* printing still works without browser storage */ } }
function updatePrintAvailability() {
  const selected = printers.find(printer => printer.name === byId('printer').value);
  byId('print').disabled = busy || !selected || selected.unavailable;
}
function status(message, error = false) { byId('status').textContent = message; byId('status').classList.toggle('error', error); }
function addLine(seed = {}) {
  const row = document.createElement('div'); row.className = 'line'; row.dataset.id = String(++sequence);
  row.innerHTML = '<div class="line-head"><span>货物明细</span><button type="button">移除</button></div><label>产品名称<input data-key="name" maxlength="200"></label><label>规格尺寸<input data-key="spec" placeholder="例如 40 × 30 × 30" maxlength="200"></label><div class="three"><label>数量（个）<input data-key="qty" type="number" min="0.000001" step="any"></label><label>单价（元）<input data-key="price" type="number" min="0" step="any"></label><label>金额<input data-key="amount" readonly></label></div><label>备注<input data-key="remark" maxlength="500"></label>';
  for (const input of row.querySelectorAll('[data-key]')) input.value = seed[input.dataset.key] ?? '';
  row.querySelector('button').addEventListener('click', () => { row.remove(); calculate(); });
  row.addEventListener('input', calculate); byId('items').appendChild(row); calculate();
}
function calculate() {
  let total = 0;
  document.querySelectorAll('.line').forEach(row => { const qty = Number(row.querySelector('[data-key="qty"]').value), price = Number(row.querySelector('[data-key="price"]').value); const cents = Math.round(qty * price * 100); row.querySelector('[data-key="amount"]').value = Number.isFinite(cents) ? (cents / 100).toFixed(2) : ''; if (Number.isFinite(cents)) total += cents; });
  byId('total').textContent = '¥' + (total / 100).toFixed(2);
}
function payload() {
  if (!byId('party').value.trim()) throw new Error('请填写收货单位');
  if (!byId('date').value) throw new Error('请选择送货日期');
  const lines = [...document.querySelectorAll('.line')].map((row, index) => {
    const value = key => row.querySelector('[data-key="' + key + '"]').value.trim();
    const quantity = Number(value('qty')), price = Number(value('price'));
    if (!value('name') || !value('qty') || !value('price') || !Number.isFinite(quantity) || quantity <= 0 || !Number.isFinite(price) || price < 0) throw new Error('第 ' + (index + 1) + ' 行需填写名称、有效数量与单价');
    return { id: index + 1, product_id: index + 1, type: 'out', product_name: value('name'), specification: value('spec'), quantity, unit: '个', unit_price: price, amount: Math.round(quantity * price * 100) / 100, remark: value('remark') };
  });
  if (!lines.length) throw new Error('至少添加一行货物');
  return { printerName: byId('printer').value, showPrices: byId('prices').checked, document: { key: 'desktop', number: 'DESKTOP-' + Date.now(), title: '送 货 单', company: byId('company').value.trim(), party: byId('party').value.trim(), address: byId('address').value.trim(), date: byId('date').value, receiver: byId('receiver').value.trim(), operator: byId('sender').value.trim(), orderNumber: '', lines } };
}
function fitFrame() {
  const frame = byId('frame'); if (!frame.contentDocument?.body) return;
  frame.contentDocument.documentElement.style.overflow = 'hidden'; frame.contentDocument.body.style.overflow = 'hidden';
  const width = 241 * 96 / 25.4 + 24, height = frame.contentDocument.body.scrollHeight + 12, scale = Math.min(1, byId('stage').clientWidth / width);
  frame.style.width = width + 'px'; frame.style.height = height + 'px'; frame.style.transform = 'scale(' + scale + ')'; byId('stage').style.height = height * scale + 'px';
}
async function preview() {
  const revision = ++previewSequence;
  try { const html = await desktopPrint.preview(payload()); if (revision !== previewSequence) return; byId('frame').srcdoc = html; status('预览已更新，打印会使用当前填写的资料。'); }
  catch (e) { if (revision === previewSequence) status(e.message, true); }
}
async function refreshPrinters() {
  try {
    const selected = preferredPrinter() || byId('printer').value;
    printers = (await desktopPrint.printers()).filter(printer => !printer.virtual);
    byId('printer').replaceChildren();
    for (const printer of printers) { const option = document.createElement('option'); option.value = printer.name; option.textContent = printer.name + (printer.unavailable ? '（不可用）' : ''); byId('printer').appendChild(option); }
    const preferred = printers.find(p => p.name === selected) || printers.find(p => /EPSON.*630/i.test(p.name) && !p.unavailable) || printers.find(p => p.isDefault && !p.unavailable) || printers.find(p => !p.unavailable) || printers[0];
    if (preferred) { byId('printer').value = preferred.name; rememberPrinter(preferred.name); }
    updatePrintAvailability();
    status(!preferred ? '没有找到实体打印机。' : preferred.unavailable ? '所选打印机不可用，请检查连接和纸张后刷新。' : '已选择 ' + preferred.name + '。点击“发送打印”后直接打印，纸张为 241 × 93 mm。', Boolean(preferred?.unavailable));
  } catch (e) { status(e.message, true); }
}
async function output(kind) {
  if (busy) return; busy = true; byId('print').disabled = true; byId('pdf').disabled = true;
  try {
    const data = payload(); status(kind === 'print' ? '正在发送到 ' + data.printerName + '…' : '正在准备 PDF…');
    const result = await desktopPrint[kind](data);
    status(result.kind === 'cancelled' ? '已取消，未发送打印。' : result.kind === 'queued' ? '已交给 ' + result.printerName + ' 的系统队列，共 ' + result.pages + ' 页。请检查实际出纸；不要重复点击。' : 'PDF 已保存：' + result.filePath);
  } catch (e) { status(e.message + (kind === 'print' ? '\n若打印已经开始，请先检查队列和实际出纸再决定是否重试。' : ''), true); }
  finally { busy = false; updatePrintAvailability(); byId('pdf').disabled = false; }
}
byId('add').addEventListener('click', () => addLine()); byId('preview').addEventListener('click', preview);
byId('printer').addEventListener('change', () => { rememberPrinter(byId('printer').value); updatePrintAvailability(); });
byId('refresh').addEventListener('click', refreshPrinters); byId('print').addEventListener('click', () => output('print')); byId('pdf').addEventListener('click', () => output('pdf'));
byId('frame').addEventListener('load', fitFrame); new ResizeObserver(fitFrame).observe(byId('stage'));
const now = new Date(); byId('date').value = `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')}-${String(now.getDate()).padStart(2, '0')}`;
addLine(); refreshPrinters();
