/* eslint-env browser */
/* global $, PreviewStore, db, esc, money, printDocument, renderPaper, renderProjectDelivery, setType, sources, type */
const baseSetType = setType, baseRenderPaper = renderPaper, basePrint = printDocument;
let deliveryMode = 'source';
let manualDocs = [];
try { manualDocs = JSON.parse(localStorage.getItem('warehouse-manual-print-preview-v1') || '[]'); } catch { /* empty local history */ }
const manualCard = document.createElement('section'); manualCard.className = 'card'; manualCard.id = 'manual-card'; manualCard.style.display = 'none';
const sourceCard = $('source').closest('.card'); sourceCard.before(manualCard);
const modeCard = document.createElement('div'); modeCard.id = 'delivery-modes'; modeCard.className = 'card';
modeCard.innerHTML = '<div class="section-head"><h2>送货单怎么开？</h2><span class="hint">两种方式都保留</span></div><div class="two"><button class="action" id="mode-source">从已有单据带入</button><button class="action" id="mode-manual">手动填写送货单</button></div><p class="note">手动单只打印，不自动扣库存、不增加客户欠款。</p>';
sourceCard.before(modeCard); $('mode-source').onclick = () => changeMode('source'); $('mode-manual').onclick = () => changeMode('manual');
const labelCard = document.createElement('section'); labelCard.className = 'card'; labelCard.style.display = 'none'; labelCard.innerHTML = '<div class="section-head"><h2>标签资料</h2><span class="hint">选择库存直接带出</span></div><label class="note" for="label-stock">入库批次 / 库存货物</label><select class="source" id="label-stock"></select><div class="two"><div class="field"><label>标签张数</label><input id="label-count" type="number" min="1" max="100" value="1"></div><div class="field"><label>标签尺寸</label><select class="source" id="label-size"><option value="60,40">60 × 40 mm</option><option value="80,50">80 × 50 mm</option></select></div></div><p class="note">带出客户、货名、规格、供货来源及入库日期。每张一页；实际打印时选择标签打印机。</p>';
sourceCard.before(labelCard);
function dateToday() { const d = new Date(); return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`; }
function changeMode(mode) {
  if (mode === 'source') { baseSetType('delivery'); sources.push(...manualDocs); $('source').innerHTML = sources.map((s, i) => `<option value="${i}">${esc(s.title)}</option>`).join(''); }
  deliveryMode = mode; manualCard.style.display = mode === 'manual' ? '' : 'none'; sourceCard.style.display = mode === 'source' ? '' : 'none';
  $('mode-source').style.background = mode === 'source' ? '#e4edff' : '#f8faff'; $('mode-manual').style.background = mode === 'manual' ? '#e4edff' : '#f8faff';
  if (mode === 'manual' && !$('manual-party')) initManual();
}
function manualField(label, id, value = '', inputType = 'text') { return `<div class="field"><label for="${id}">${label}</label><input id="${id}" type="${inputType}" value="${esc(value)}"></div>`; }
function initManual() {
  manualCard.innerHTML = '<div class="section-head"><h2>手动填写送货单</h2><span class="hint">不影响真实业务</span></div>' + manualField('公司名称', 'manual-company', '东光县曙光纸箱包装') + manualField('收货单位（必填）', 'manual-party') + manualField('收货地址', 'manual-address') + manualField('送货日期', 'manual-date', dateToday(), 'date') + '<div class="two">' + manualField('收货人', 'manual-receiver') + manualField('送货人', 'manual-sender') + '</div><div id="manual-lines"></div><button class="action" id="manual-add">＋ 添加货物</button><div class="flow-note" id="manual-total" style="margin-top:12px">合计 ¥0.00</div><button class="primary" id="manual-generate">保存并生成送货单预览</button><p class="note" id="manual-message" role="status">保存于当前浏览器，未创建真实出库和应收。</p>';
  $('manual-add').onclick = () => addManualLine(); $('manual-generate').onclick = generateManual; addManualLine();
  const help = document.createElement('p'); help.className = 'note'; help.textContent = '货名或规格输入“30”等关键词，即可选择已有货物；选中带出完整规格与参考单价。当前搜索的是预览资料，尚未连接正式规格库。'; $('manual-lines').before(help);
  let draft; try { draft = JSON.parse(localStorage.getItem('warehouse-manual-print-draft-v1') || 'null'); } catch { /* no draft */ }
  if (draft) { for (const [id, value] of Object.entries(draft.fields || {})) if ($(id)) $(id).value = value; $('manual-lines').replaceChildren(); for (const l of draft.lines || []) addManualLine(l); if (!$('manual-lines').children.length) addManualLine(); }
  manualCard.addEventListener('input', saveDraft);
}
function addManualLine(seed = {}) {
  const row = document.createElement('div'); row.className = 'manual-line'; row.style.cssText = 'padding:13px;background:#f7faff;border:1px solid #e4ecf6;border-radius:12px;margin-bottom:12px';
  row.innerHTML = '<div class="section-head"><span class="hint">货物明细</span><button class="link">移除</button></div><div class="field"><label>产品名称</label><input data-k="goods" maxlength="200"></div><div class="field"><label>规格尺寸 / 长 × 宽 × 高</label><input data-k="spec" maxlength="200"></div><div class="two"><div class="field"><label>数量（个）</label><input data-k="qty" type="number" min="0" step="any"></div><div class="field"><label>单价（元）</label><input data-k="price" type="number" min="0" step="any"></div></div><div class="field"><label>备注</label><input data-k="remark" maxlength="500"></div><div class="hint" data-line-total>本行金额 ¥0.00</div>';
  row.querySelectorAll('[data-k]').forEach(i => { i.value = seed[i.dataset.k] ?? ''; }); row.querySelector('button').onclick = () => { row.remove(); saveDraft(); }; $('manual-lines').appendChild(row); updateManualTotal();
  const suggestions = document.createElement('div'); suggestions.className = 'goods-suggestions'; suggestions.setAttribute('role', 'region'); suggestions.setAttribute('aria-label', '匹配的已有货物'); row.querySelector('[data-k="spec"]').closest('.field').after(suggestions);
  for (const key of ['goods', 'spec']) row.querySelector('[data-k="' + key + '"]').addEventListener('input', e => showGoods(row, suggestions, e.target.value));
}
function showGoods(row, target, query) {
  target.replaceChildren(); const needle = query.trim().toLowerCase().replace(/\s+/g, ''); if (!needle) return;
  const store = PreviewStore.read(), options = store.customers.flatMap(c => c.specs.map(s => ({ goods: s.name, spec: s.size, price: s.price, customer: c.name, source: '客户常用' }))).concat(store.stock.filter(s => s.kind === 'carton').map(s => ({ goods: s.name, spec: s.size, customer: s.customerName || store.customers.find(c => c.id === s.customerId)?.name || '', source: '成品库存' })));
  const selectedCustomer = $('manual-party').value.trim();
  const matches = options.filter(s => (!selectedCustomer || !s.customer || s.customer === selectedCustomer) && (s.goods + s.spec).toLowerCase().replace(/\s+/g, '').includes(needle)).slice(0, 8);
  if (!matches.length) { target.textContent = '没有匹配的预览资料，可以继续手动填写。'; target.classList.add('note'); return; }
  for (const item of matches) {
    const button = document.createElement('button'); button.type = 'button'; button.className = 'goods-match'; button.style.cssText = 'display:block;width:100%;text-align:left;padding:10px;margin:5px 0;border:1px solid #d9e6fa;border-radius:8px;background:#edf4ff;color:#486eaa;font-size:11px';
    button.textContent = item.goods + ' · ' + item.spec + ' · ' + (item.customer || '公共库存') + ' · ' + item.source + (item.price != null ? ' · ¥' + money(item.price) : ' · 单价需核对');
    button.onclick = () => { row.querySelector('[data-k="goods"]').value = item.goods; row.querySelector('[data-k="spec"]').value = item.spec; row.querySelector('[data-k="price"]').value = item.price ?? ''; if (!$('manual-party').value.trim() && item.customer) { $('manual-party').value = item.customer; const customer = store.customers.find(c => c.name === item.customer); if (customer && !$('manual-address').value.trim()) $('manual-address').value = customer.address || ''; } target.replaceChildren(); saveDraft(); row.querySelector('[data-k="qty"]').focus(); };
    target.appendChild(button);
  }
}
function readManualLines() { return [...document.querySelectorAll('.manual-line')].map(row => Object.fromEntries([...row.querySelectorAll('[data-k]')].map(i => [i.dataset.k, i.value]))); }
function updateManualTotal() { let sum = 0; document.querySelectorAll('.manual-line').forEach(row => { const qty = Number(row.querySelector('[data-k="qty"]').value), price = Number(row.querySelector('[data-k="price"]').value), amount = Math.round(qty * price * 100) / 100; if (Number.isFinite(amount)) sum += Math.round(amount * 100); row.querySelector('[data-line-total]').textContent = '本行金额 ¥' + money(Number.isFinite(amount) ? amount : 0); }); if ($('manual-total')) $('manual-total').textContent = '合计 ¥' + money(sum / 100); }
function saveDraft() { updateManualTotal(); const fields = {}; for (const id of ['manual-company', 'manual-party', 'manual-address', 'manual-date', 'manual-receiver', 'manual-sender']) fields[id] = $(id).value; try { localStorage.setItem('warehouse-manual-print-draft-v1', JSON.stringify({ fields, lines: readManualLines() })); } catch { /* unavailable storage */ } }
function generateManual() {
  const rows = readManualLines();
  if (!$('manual-party').value.trim() || !$('manual-date').value || !rows.length || rows.some(l => !l.goods.trim() || !l.qty.trim() || !l.price.trim() || !Number.isFinite(Number(l.qty)) || Number(l.qty) <= 0 || !Number.isFinite(Number(l.price)) || Number(l.price) < 0 || !Number.isSafeInteger(Math.round(Number(l.qty) * Number(l.price) * 100)))) { $('manual-message').textContent = '请填写客户、日期，并核对每行货名、数量和单价。'; return; }
  const doc = { id: 'manual-' + Date.now(), title: '手动单 · ' + $('manual-party').value.trim() + ' · ' + $('manual-date').value, party: $('manual-party').value.trim(), date: $('manual-date').value, address: $('manual-address').value.trim(), company: $('manual-company').value.trim(), sender: $('manual-sender').value.trim(), receiver: $('manual-receiver').value.trim(), lines: rows.map(l => ({ ...l, qty: Number(l.qty), price: Number(l.price), total: Math.round(Number(l.qty) * Number(l.price) * 100) / 100 })), note: '手动打印单，不扣库存，不增加应收。' };
  manualDocs.unshift(doc); manualDocs = manualDocs.slice(0, 100); try { localStorage.setItem('warehouse-manual-print-preview-v1', JSON.stringify(manualDocs)); } catch { /* session still works */ }
  renderMyDocuments();
  sources = [doc]; $('source').innerHTML = '<option value="0">' + esc(doc.title) + '</option>'; renderProjectDelivery(); saveDraft(); $('manual-message').textContent = '已保存手动单，下面可查看原模板预览并打开系统打印。'; $('preview').scrollIntoView({ behavior: 'smooth', block: 'center' });
}
setType = function (key) {
  modeCard.style.display = key === 'delivery' ? '' : 'none'; manualCard.style.display = 'none'; labelCard.style.display = 'none'; sourceCard.style.display = '';
  $('paper').style.padding = '';
  if (key === 'label') {
    type = key; db = PreviewStore.read(); for (const k of ['delivery', 'label', 'statement']) { $('type-' + k).classList.toggle('active', k === key); $('type-' + k).setAttribute('aria-selected', String(k === key)); }
    sourceCard.style.display = 'none'; labelCard.style.display = ''; $('label-stock').innerHTML = db.stock.map(s => `<option value="${s.id}">${esc(s.name + ' · ' + s.size)}</option>`).join(''); $('label-stock').onchange = renderLabel; $('label-count').oninput = renderLabel; $('label-size').onchange = renderLabel; renderLabel(); return;
  }
  baseSetType(key);
  if (key === 'delivery') { sources.push(...manualDocs); $('source').innerHTML = sources.map((s, i) => `<option value="${i}">${esc(s.title)}</option>`).join(''); changeMode(deliveryMode); }
};
function renderLabel() {
  const s = db.stock.find(s => s.id === Number($('label-stock').value)); if (!s) { $('paper').textContent = '暂无库存货物'; return; }
  const count = Number($('label-count').value), [w, h] = $('label-size').value.split(',').map(Number); if (!Number.isInteger(count) || count < 1 || count > 100) { $('paper').textContent = '标签张数需为 1 至 100 的整数'; return; }
  const client = s.customerName || db.customers.find(c => c.id === s.customerId)?.name || '公共备货';
  const content = `<h2>${esc(s.name)}</h2><p>客户：${esc(client)}</p><p>规格：${esc(s.size)}</p><p>供货来源：${esc(s.supplier || '自产 / 未关联供货商')}</p><p>入库：${esc(s.enteredAt || '未记录')}</p><small>批次 ${s.id} · 预览标签</small>`;
  window.labelHtml = `<!doctype html><html lang="zh-CN"><head><meta charset="utf-8"><style>@page{size:${w}mm ${h}mm;margin:0}*{box-sizing:border-box}body{margin:0;font:9pt/1.3 'Microsoft YaHei',sans-serif}.label{width:${w}mm;height:${h}mm;padding:2mm;border:1px solid #222;overflow:hidden;break-after:page}.label:last-child{break-after:auto}h2{margin:0 0 1mm;font-size:12pt}p{margin:.6mm 0}small{font-size:7pt}</style></head><body>${Array.from({ length: count }, () => '<section class="label">' + content + '</section>').join('')}</body></html>`;
  $('paper').style.padding = '16px'; $('paper').innerHTML = '<div class="watermark">标签样张 · ' + w + ' × ' + h + ' mm · 共 ' + count + ' 张</div><div style="border:1px solid #25374e;padding:15px;text-align:left;font-size:12px;line-height:1.8">' + content + '</div><iframe id="label-frame" title="标签打印内容" style="position:absolute;width:1px;height:1px;opacity:0;pointer-events:none;border:0"></iframe>'; $('label-frame').srcdoc = window.labelHtml;
}
renderPaper = function () { if (type === 'label') return renderLabel(); return baseRenderPaper(); };
printDocument = function () { if (type !== 'label') return basePrint(); const f = $('label-frame'); if (!f) return; f.contentWindow.focus(); f.contentWindow.print(); };
const documentsCard = document.createElement('section'); documentsCard.className = 'card'; documentsCard.id = 'my-documents';
$('preview').after(documentsCard);
function renderMyDocuments(query = '') {
  if (!$('document-search')) { documentsCard.innerHTML = '<div class="section-head"><h2>我的单据</h2><span class="hint">已保存的手动送货单</span></div><input class="source" id="document-search" type="search" aria-label="搜索我的单据" placeholder="搜索客户、日期、货物或规格"><div id="document-list" style="margin-top:12px"></div><p class="note">只保存在当前浏览器。正式版会接入项目历史单据，支持多设备同步。草稿在“手动填写送货单”中继续编辑。</p>'; $('document-search').oninput = e => renderMyDocuments(e.target.value); }
  const list = $('document-list'); list.replaceChildren(); const matches = manualDocs.filter(d => (d.title + ' ' + d.lines.map(l => l.goods + ' ' + l.spec).join(' ')).toLowerCase().includes(query.trim().toLowerCase()));
  if (!matches.length) { list.innerHTML = '<p class="note">' + (manualDocs.length ? '没有找到匹配单据。' : '暂无保存单据。手动填写后点击“保存并生成送货单预览”，就会出现在这里。') + '</p>'; return; }
  for (const doc of matches) { const entry = document.createElement('div'); entry.className = 'recent'; entry.style.alignItems = 'center'; const summary = document.createElement('span'); summary.textContent = doc.party + ' · ' + doc.date; const extra = document.createElement('small'); extra.style.cssText = 'display:block;margin-top:5px'; extra.textContent = doc.lines.length + ' 项 · ¥' + money(doc.lines.reduce((a, l) => a + l.total, 0)) + ' · ' + doc.lines.map(l => l.goods).join('、'); summary.appendChild(extra); const button = document.createElement('button'); button.className = 'action'; button.textContent = '查看 / 重打'; button.onclick = () => { setType('delivery'); changeMode('source'); sources = [doc, ...sources.filter(s => s.id !== doc.id)]; $('source').innerHTML = sources.map((s, i) => '<option value="' + i + '">' + esc(s.title) + '</option>').join(''); renderProjectDelivery(); $('preview').scrollIntoView({ behavior: 'smooth', block: 'center' }); }; entry.append(summary, button); list.appendChild(entry); }
}
const documentJump = document.createElement('button'); documentJump.className = 'link'; documentJump.textContent = '我的单据 ›'; documentJump.style.cssText = 'margin-left:auto;color:#2469ee'; documentJump.onclick = () => documentsCard.scrollIntoView({ behavior: 'smooth', block: 'start' }); document.querySelector('.header .meta').appendChild(documentJump);
renderMyDocuments();
setType('delivery');
