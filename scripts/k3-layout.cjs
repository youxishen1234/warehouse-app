// K3 label layout. Produces self-contained HTML sized in printer pixels
// (203 dpi => 8 px per millimetre) so the rendered bitmap maps 1:1 to the head.
const QRCode = require('qrcode');

const PX_PER_MM = 8;
const px = mm => Math.round(mm * PX_PER_MM);

const ESCAPES = { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' };
const esc = value => String(value ?? '').replace(/[&<>"']/g, character => ESCAPES[character]);
const text = value => (typeof value === 'string' ? value.trim() : value === undefined || value === null ? '' : String(value));
const number = value => (typeof value === 'number' && Number.isFinite(value) ? value : null);
const fmt = value => {
  const parsed = number(value);
  if (parsed === null) return text(value);
  return Number.isInteger(parsed) ? String(parsed) : String(Number(parsed.toFixed(3)));
};
const when = value => text(value);

function finishedFields(data) {
  const rows = [];
  rows.push(['商品名称', when(data.name), 'name']);
  rows.push(['规格', when(data.specification), 'spec']);
  if (when(data.unit)) rows.push(['单位', when(data.unit), 'unit']);
  if (when(data.material)) rows.push(['材质', when(data.material), 'material']);
  if (when(data.corrugation)) rows.push(['楞型', when(data.corrugation), 'corrugation']);
  if (number(data.layers)) rows.push(['层数', `${fmt(data.layers)} 层`, 'layers']);
  if (number(data.weight)) rows.push(['克重', `${fmt(data.weight)} g/m²`, 'weight']);
  if (number(data.stockSnapshot)) rows.push(['打印时库存', `${fmt(data.stockSnapshot)} ${when(data.unit) || ''}`.trim(), 'stock']);
  if (when(data.printedAt)) {
    const date = new Date(data.printedAt);
    rows.push(['打印日期', Number.isNaN(date.getTime()) ? when(data.printedAt) : date.toLocaleString('zh-CN', { hour12: false, timeZone: 'Asia/Shanghai' }), 'printedAt']);
  }
  return rows;
}

function boardFields(data) {
  const rows = [];
  rows.push(['纸板规格', `${fmt(data.boardLength)} × ${fmt(data.boardWidth)} cm`, 'spec']);
  rows.push(['楞型', when(data.fluteType), 'flute']);
  rows.push(['板厂', when(data.supplier), 'supplier']);
  rows.push(['批次', when(data.batchId), 'batch']);
  if (number(data.layers)) rows.push(['层数', `${fmt(data.layers)} 层`, 'layers']);
  if (number(data.faceGsm)) rows.push(['面纸', `${fmt(data.faceGsm)} g/m²`, 'face']);
  if (number(data.linerGsm)) rows.push(['里纸', `${fmt(data.linerGsm)} g/m²`, 'liner']);
  if (number(data.flutingGsm)) rows.push(['楞纸', `${fmt(data.flutingGsm)} g/m²`, 'fluting']);
  if (number(data.cartonLength) && number(data.cartonWidth) && number(data.cartonHeight)) {
    rows.push(['纸箱尺寸', `${fmt(data.cartonLength)} × ${fmt(data.cartonWidth)} × ${fmt(data.cartonHeight)} cm`, 'carton']);
  }
  if (when(data.receivedDate)) rows.push(['入库日期', when(data.receivedDate), 'received']);
  if (when(data.location)) rows.push(['库位', when(data.location), 'location']);
  if (number(data.receivedQty)) rows.push(['实收数量', `${fmt(data.receivedQty)} 张`, 'receivedQty']);
  if (number(data.remainingQtySnapshot)) rows.push(['打印时余量', `${fmt(data.remainingQtySnapshot)} 张`, 'remaining']);
  return rows;
}

const STYLE = `
*{box-sizing:border-box;margin:0;padding:0}
html,body{background:#fff}
body{font-family:"Microsoft YaHei","Microsoft YaHei UI","SimHei",sans-serif;color:#000;-webkit-font-smoothing:antialiased}
.warehouse-label{position:relative;overflow:hidden;background:#fff}
.label-body{position:absolute;display:flex;flex-direction:column;overflow:hidden}
.head{display:flex;align-items:flex-end;justify-content:space-between}
.kind{font-weight:700;letter-spacing:0}
.brand{font-weight:600}
.rule{background:#000}
.title{font-weight:700;line-height:1.12;word-break:break-all}
.subtitle{line-height:1.2;word-break:break-all}
.fields{display:flex;flex-direction:column}
.row{display:flex;align-items:baseline;border-bottom:1px solid #000}
.k{flex:0 0 auto;font-weight:600}
.v{flex:1 1 auto;text-align:right;word-break:break-all}
.foot{margin-top:auto;display:flex;align-items:flex-end;justify-content:space-between}
.qr{line-height:0}
.qr img{display:block;image-rendering:pixelated}
.meta{text-align:right;line-height:1.35;word-break:break-all}
.cal{position:absolute;display:flex;flex-direction:column;align-items:center;justify-content:space-between;outline:2px solid #000;outline-offset:-2px}
.cal-top{font-weight:700}
.cal-mid{font-weight:700;text-align:center;line-height:1.5}
.cal-small{text-align:center;line-height:1.5}
`;

/**
 * Builds the label HTML. `kind` is 'finished-product' | 'paperboard-batch'.
 * Returns warnings; any warning means the caller must not send the job.
 */
async function buildLabelHtml({ kind, data, profile }) {
  if (!profile || typeof profile.widthMm !== 'number' || typeof profile.heightMm !== 'number') throw new Error('纸张配置无效');
  const width = px(profile.widthMm), height = px(profile.heightMm);
  const margin = {
    top: px(profile.marginMm?.top ?? 1), right: px(profile.marginMm?.right ?? 1),
    bottom: px(profile.marginMm?.bottom ?? 1), left: px(profile.marginMm?.left ?? 1),
  };
  const usableWidth = width - margin.left - margin.right;
  const usableHeight = height - margin.top - margin.bottom;
  if (usableWidth < 120 || usableHeight < 200) throw new Error('标签可用区域过小，无法排版');

  const warnings = [];
  const isBoard = kind === 'paperboard-batch';
  const rows = isBoard ? boardFields(data || {}) : finishedFields(data || {});
  const url = text(isBoard ? data?.batchUrl : data?.productUrl);
  const headline = isBoard
    ? `${fmt(data.boardLength)} × ${fmt(data.boardWidth)} cm`
    : text(data.name);

  const kindLabel = isBoard ? '纸板批次标签' : '成品标签';
  const qrSize = Math.min(px(26), Math.max(px(18), Math.round(usableWidth * 0.34)));
  let qrHtml = '';
  if (!/^https:\/\/youxishen\.online\/#\/pages\/label-resolver\/index\?v=1&kind=/.test(url)) {
    warnings.push('标签二维码链接缺失或格式无效，已停止打印');
  } else {
    const png = await QRCode.toDataURL(url, { errorCorrectionLevel: 'M', margin: 4, width: qrSize, color: { dark: '#000000ff', light: '#ffffffff' } });
    qrHtml = `<div class="qr" data-qr><img src="${png}" width="${qrSize}" height="${qrSize}" alt=""></div>`;
  }

  // Vertical budget: header, rule, headline (2 lines), fields, footer (QR).
  const kindSize = Math.round(Math.max(16, Math.min(28, usableWidth / 17)));
  const headlineSize = Math.round(Math.max(26, Math.min(64, usableWidth / (isBoard ? 9 : 7))));
  const rowSize = Math.round(Math.max(17, Math.min(26, usableWidth / 22)));
  const rowHeight = Math.round(rowSize * 1.55);
  const headerHeight = Math.round(kindSize * 1.6) + 6;
  const headlineLines = Math.min(2, Math.max(1, Math.ceil(headline.length / (isBoard ? 9 : 7))));
  const headlineHeight = headlineSize * 1.12 * headlineLines;
  const fieldsHeight = rows.length * rowHeight;
  const footHeight = qrSize + 8;
  const needed = headerHeight + 3 + headlineHeight + 8 + fieldsHeight + 10 + footHeight;
  if (needed > usableHeight) {
    warnings.push(`标签内容高度约 ${Math.round(needed / PX_PER_MM)} mm，超过可用 ${Math.round(usableHeight / PX_PER_MM)} mm；请关闭可选字段或换更大纸卷`);
  }
  if (headline.length > (isBoard ? 18 : 14) * 2) warnings.push('主标题过长，已按两行显示，请核对实物');

  const fieldHtml = rows.map(([label, value, key]) => {
    const long = value.length > 30;
    if (long) warnings.push(`字段「${label}」较长，请核对是否完整显示`);
    return `<div class="row" data-field="${esc(key)}"><span class="k">${esc(label)}</span><span class="v">${esc(value)}</span></div>`;
  }).join('');

  const meta = isBoard
    ? `<div class="meta">${esc(text(data.batchId))}<br>扫码查看批次</div>`
    : `<div class="meta">ID ${esc(fmt(data.productId))}<br>扫码查看商品</div>`;

  const html = `<!doctype html><html><head><meta charset="utf-8"><style>${STYLE}
.warehouse-label{width:${width}px;height:${height}px}
.label-body{left:${margin.left}px;top:${margin.top}px;width:${usableWidth}px;height:${usableHeight}px}
.head{height:${headerHeight}px}
.kind{font-size:${kindSize}px}
.brand{font-size:${Math.round(kindSize * 0.7)}px}
.rule{height:3px;margin-bottom:8px}
.title{font-size:${headlineSize}px}
.subtitle{font-size:${Math.round(headlineSize * 0.55)}px;margin-top:6px}
.fields{margin-top:10px;font-size:${rowSize}px}
.row{height:${rowHeight}px;line-height:${rowHeight}px}
.k{width:${Math.round(usableWidth * 0.36)}px;padding-right:8px}
.meta{font-size:${Math.round(rowSize * 0.72)}px}
</style></head><body>
<div class="warehouse-label" data-page>
  <div class="label-body" data-body>
    <div class="head"><div class="kind">${esc(kindLabel)}</div><div class="brand">曙光纸箱</div></div>
    <div class="rule"></div>
    <div class="title" data-title>${esc(headline)}</div>
    ${isBoard ? `<div class="subtitle">${esc(text(data.fluteType))} · ${esc(text(data.supplier))}</div>` : ''}
    <div class="fields">${fieldHtml}</div>
    <div class="foot">${qrHtml}${meta}</div>
  </div>
</div></body></html>`;
  return { html, warnings };
}

async function buildCalibrationHtml({ profile }) {
  const width = px(profile.widthMm), height = px(profile.heightMm);
  const margin = {
    top: px(profile.marginMm?.top ?? 1), right: px(profile.marginMm?.right ?? 1),
    bottom: px(profile.marginMm?.bottom ?? 1), left: px(profile.marginMm?.left ?? 1),
  };
  const usableWidth = width - margin.left - margin.right;
  const usableHeight = height - margin.top - margin.bottom;
  const big = Math.round(Math.max(20, Math.min(44, usableWidth / 13)));
  const html = `<!doctype html><html><head><meta charset="utf-8"><style>${STYLE}
.warehouse-label{width:${width}px;height:${height}px}
.cal{left:${margin.left}px;top:${margin.top}px;width:${usableWidth}px;height:${usableHeight}px;padding:${Math.round(usableWidth * 0.07)}px}
.cal-top{font-size:${big}px}
.cal-mid{font-size:${Math.round(big * 0.8)}px}
.cal-small{font-size:${Math.round(big * 0.62)}px}
</style></head><body>
<div class="warehouse-label" data-page>
  <div class="cal" data-body>
    <div class="cal-top">校准样张</div>
    <div class="cal-mid">K3 ${profile.widthMm} × ${profile.heightMm} mm<br>中文 成品 纸板 × g/m²</div>
    <div class="cal-small">请核对四边、方向、浓度与走纸<br>${new Date().toLocaleString('zh-CN', { hour12: false, timeZone: 'Asia/Shanghai' })}</div>
  </div>
</div></body></html>`;
  return { html, warnings: [] };
}

module.exports = { buildLabelHtml, buildCalibrationHtml, px, PX_PER_MM };
