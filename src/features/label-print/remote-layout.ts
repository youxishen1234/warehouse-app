import QRCode from 'qrcode';
import type { MediaProfile } from './native';
import type { LabelSnapshot, ManualBoardLabelSnapshot, RemotePrintableLabelKind } from './model';
import sourceHanHeavy from '../../assets/label-fonts/SourceHanSansSC-Heavy.woff2';
import sourceHanMedium from '../../assets/label-fonts/SourceHanSansSC-Medium.woff2';

const DOTS_PER_MM = 8;
const mm = (value: number) => `${value}mm`;
const esc = (value: unknown) => String(value ?? '').replace(/[&<>"']/g, character =>
  ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[character]!);
const text = (value: unknown) => typeof value === 'string' ? value.trim() : value == null ? '' : String(value);
const num = (value: unknown) => typeof value === 'number' && Number.isFinite(value) ? value : null;
const decimal = (value: unknown) => {
  const parsed = num(value);
  if (parsed === null) return text(value);
  return Number.isInteger(parsed) ? String(parsed) : String(Number(parsed.toFixed(3)));
};

type LabelRow = readonly [label: string, value: string, key: string];

function finishedRows(data: LabelSnapshot): LabelRow[] {
  if (!('productId' in data)) return [];
  const rows: LabelRow[] = [
    ['商品名称', text(data.name), 'name'],
    ['规格', text(data.specification), 'spec']
  ];
  if (text(data.unit)) rows.push(['单位', text(data.unit), 'unit']);
  if (text(data.material)) rows.push(['材质', text(data.material), 'material']);
  if (text(data.corrugation)) rows.push(['楞型', text(data.corrugation), 'corrugation']);
  if (num(data.layers)) rows.push(['层数', `${decimal(data.layers)} 层`, 'layers']);
  if (num(data.weight)) rows.push(['克重', `${decimal(data.weight)} g/m²`, 'weight']);
  if (num(data.stockSnapshot)) rows.push(['打印时库存', `${decimal(data.stockSnapshot)} ${text(data.unit)}`.trim(), 'stock']);
  if (data.printedAt) {
    const value = new Date(data.printedAt);
    rows.push(['打印日期', Number.isNaN(value.getTime()) ? data.printedAt : value.toLocaleString('zh-CN', { hour12: false }), 'printedAt']);
  }
  return rows;
}

function boardRows(data: LabelSnapshot): LabelRow[] {
  if (!('batchId' in data)) return [];
  const rows: LabelRow[] = [
    ['纸板规格', `${decimal(data.boardLength)} × ${decimal(data.boardWidth)} cm`, 'spec'],
    ['楞型', text(data.fluteType), 'flute'],
    ['板厂', text(data.supplier), 'supplier'],
    ['批次', text(data.batchId), 'batch']
  ];
  if (num(data.layers)) rows.push(['层数', `${decimal(data.layers)} 层`, 'layers']);
  if (num(data.faceGsm)) rows.push(['面纸', `${decimal(data.faceGsm)} g/m²`, 'face']);
  if (num(data.linerGsm)) rows.push(['里纸', `${decimal(data.linerGsm)} g/m²`, 'liner']);
  if (num(data.flutingGsm)) rows.push(['楞纸', `${decimal(data.flutingGsm)} g/m²`, 'fluting']);
  if (num(data.cartonLength) && num(data.cartonWidth) && num(data.cartonHeight)) {
    rows.push(['纸箱尺寸', `${decimal(data.cartonLength)} × ${decimal(data.cartonWidth)} × ${decimal(data.cartonHeight)} cm`, 'carton']);
  }
  if (text(data.receivedDate)) rows.push(['入库日期', text(data.receivedDate), 'received']);
  if (text(data.location)) rows.push(['库位', text(data.location), 'location']);
  if (num(data.receivedQty)) rows.push(['实收数量', `${decimal(data.receivedQty)} 张`, 'receivedQty']);
  if (num(data.remainingQtySnapshot)) rows.push(['打印时余量', `${decimal(data.remainingQtySnapshot)} 张`, 'remaining']);
  return rows;
}

function manualBoardRows(data: ManualBoardLabelSnapshot): LabelRow[] {
  const plate = [text(data.printPlate), text(data.printColor)].filter(Boolean).join(' · ');
  return [
    ['客户', text(data.customerName), 'customer'],
    ['规格 · 长 × 宽（cm）', `${decimal(data.boardLength)} × ${decimal(data.boardWidth)}`, 'spec'],
    ['材质 / 配纸', text(data.material), 'material'],
    ['印刷版 · 版名 / 颜色', plate || '未填写', 'plate']
  ];
}

const PAPERBOARD_LABEL_STYLE = `
@font-face{font-family:PaperboardSourceHan;src:url("${sourceHanHeavy}") format("woff2");font-style:normal;font-weight:900;font-display:block}
@font-face{font-family:PaperboardSourceHan;src:url("${sourceHanMedium}") format("woff2");font-style:normal;font-weight:500;font-display:block}
*{box-sizing:border-box;margin:0;padding:0}
html,body{background:#fff}
body{font-family:PaperboardSourceHan,sans-serif;color:#000;-webkit-font-smoothing:antialiased}
.warehouse-label{position:relative;overflow:hidden;background:#fff;transform-origin:top left}
.paperboard-label{display:flex;flex-direction:column;overflow:hidden;padding:2.5mm 3mm}
.paperboard-header{height:6mm;flex:0 0 auto;display:flex;align-items:flex-start;justify-content:space-between;border-bottom:.5mm solid #000;font-size:3.5mm;font-weight:900;letter-spacing:0}
.paperboard-tag{font-size:2mm;letter-spacing:0;padding-top:.6mm;font-weight:500}
.paperboard-major{flex:0 0 auto;padding:.8mm 0 .8mm;border-bottom:.25mm solid #000}
.paperboard-key{font-size:3mm;font-weight:500;line-height:1.2;margin-bottom:.55mm}
.paperboard-value{font-size:7.25mm;font-weight:900;letter-spacing:0;line-height:1.15;max-height:2.5em;overflow:visible;overflow-wrap:anywhere;word-break:break-word}
.paperboard-spec .paperboard-value{font-size:7.75mm}
.paperboard-plate{border-bottom:.5mm solid #000}
.paperboard-bottom{display:flex;gap:1.75mm;align-items:center;margin-top:auto;padding-top:0.5mm;min-height:24.5mm}
.paperboard-details{flex:1;min-width:0;font-size:3.375mm;font-weight:500;line-height:1.55;overflow:hidden}
.paperboard-batch{font-size:2.375mm;line-height:1.4;overflow-wrap:anywhere;word-break:break-word}
.paperboard-manual-note{font-size:2.75mm;font-weight:700;line-height:1.4;color:#333}
.paperboard-qr{width:24mm;height:24mm;flex:0 0 24mm;display:flex;align-items:center;justify-content:center}
.paperboard-qr img{display:block;width:24mm;height:24mm;image-rendering:pixelated}
`;

async function buildLargePaperboardLabel(
  profile: MediaProfile, data: LabelSnapshot, manual = false
): Promise<{ html: string; warnings: string[] }> {
  if (!('boardLength' in data) || (!manual && !('batchId' in data))) throw new Error('纸板标签资料无效');
  const customer = text(data.customerName) || '未填写';
  const material = text(data.material) || '未填写';
  const plate = [text(data.printPlate), text(data.printColor)].filter(Boolean).join(' · ') || '未填写';
  const length = decimal(data.boardLength), width = decimal(data.boardWidth);
  const quantity = manual
    ? num('receivedQty' in data ? data.receivedQty : undefined)
    : num('remainingQtySnapshot' in data ? data.remainingQtySnapshot : undefined) ??
      num('receivedQty' in data ? data.receivedQty : undefined);
  const date = manual
    ? text(data.receivedDate)
    : text('receivedDate' in data ? data.receivedDate : undefined) || '未填写';
  const url = manual || !('batchUrl' in data) ? '' : text(data.batchUrl);
  const warnings: string[] = [];
  if (!manual && !url.startsWith('https://youxishen.online/#/pages/label-resolver/index?v=1&kind=paperboard-batch&id=')) {
    warnings.push('二维码链接与当前纸板批次不一致，已停止打印');
  }
  const qr = !manual && !warnings.length
    ? await QRCode.toDataURL(url, {
      errorCorrectionLevel: 'M', margin: 4, width: 336,
      color: { dark: '#000000ff', light: '#ffffffff' }
    })
    : '';
  const values: LabelRow[] = manual
    ? manualBoardRows(data as ManualBoardLabelSnapshot)
    : [['客户', customer, 'customer'], ['规格 · 长 × 宽（cm）', `${length} × ${width}`, 'spec'],
      ['材质 / 配纸', material, 'material'], ['印刷版 · 版名 / 颜色', plate, 'plate']];
  const fields = values.map(([label, value, key]) =>
    `<div class="paperboard-major${key === 'spec' ? ' paperboard-spec' : ''}${key === 'plate' ? ' paperboard-plate' : ''}">` +
    `<div class="paperboard-key">${esc(label)}</div>` +
    `<div class="paperboard-value" data-fit data-field="${key}">${esc(value)}</div></div>`
  ).join('');
  const qtyText = quantity === null ? '' : decimal(quantity);
  const batch = 'batchId' in data ? text(data.batchId) : '';
  const details = manual
    ? [
      quantity === null ? '' : `数量：${esc(qtyText)} 张`,
      date ? `日期：${esc(date)}` : ''
    ].filter(Boolean).join('<br>')
    : `数量：${quantity === null ? '未填写' : `${esc(qtyText)}`} 张<br>日期：${esc(date)}`;
  const batchLine = batch ? `<br><span class="paperboard-batch">批次：${esc(batch)}</span>` : '';
  const widthMm = profile.widthMm, heightMm = profile.heightMm;
  const html = `<!doctype html><html lang="zh-CN"><head><meta charset="utf-8">
<meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src 'unsafe-inline'; img-src data:; font-src 'self' data:; base-uri 'none'">
<style>${PAPERBOARD_LABEL_STYLE}
.warehouse-label{width:${mm(widthMm)};height:${mm(heightMm)}}
.paperboard-label{width:${mm(widthMm)};height:${mm(heightMm)};padding:${mm(profile.marginMm.top + 2.5)} ${mm(profile.marginMm.right + 3)} ${mm(profile.marginMm.bottom + 2.5)} ${mm(profile.marginMm.left + 3)}}
</style></head><body><div class="warehouse-label paperboard-label" data-page data-fit>
  <div class="paperboard-header"><span>纸板标签</span><span class="paperboard-tag">${manual ? '手填标签 · 生产识别' : '客户专用 · 生产识别'}</span></div>
  ${fields}
  <div class="paperboard-bottom">
    <div class="paperboard-details">${details}${batchLine}</div>
    ${manual ? '<div class="paperboard-manual-note">手填标签<br>不关联库存批次</div>' : ''}
    ${qr ? `<div class="paperboard-qr" data-qr><img src="${qr}" alt="批次二维码"></div>` : ''}
  </div>
</div></body></html>`;
  return { html, warnings };
}

const STYLE = `
*{box-sizing:border-box;margin:0;padding:0}
html,body{background:#fff}
body{font-family:"Microsoft YaHei","Microsoft YaHei UI","SimHei",sans-serif;color:#000;-webkit-font-smoothing:antialiased}
.warehouse-label{position:relative;overflow:hidden;background:#fff;transform-origin:top left}
.label-body{position:absolute;display:flex;flex-direction:column;overflow:hidden}
.head{display:flex;align-items:flex-end;justify-content:space-between}
.kind{font-weight:700}
.brand{font-weight:600}
.rule{background:#000;width:100%}
.title{font-weight:700;line-height:1.12;word-break:break-all}
.subtitle{line-height:1.2;word-break:break-all}
.fields{display:flex;flex-direction:column}
.row{display:flex;align-items:baseline;border-bottom:1px solid #000}
.k{flex:0 0 auto;font-weight:600}
.v{flex:1 1 auto;text-align:right;word-break:break-all}
.foot{margin-top:auto;display:flex;align-items:flex-end;justify-content:space-between;gap:2mm}
.qr{line-height:0;flex:0 0 auto}
.qr img{display:block;image-rendering:pixelated}
.meta{text-align:right;line-height:1.35;word-break:break-all}
`;

/** Same content ordering as the PC renderer. Units are physical millimetres. */
export async function buildRemoteLabelHtml(input: {
  kind: RemotePrintableLabelKind; profile: MediaProfile; copies: number; data: LabelSnapshot;
}): Promise<{ html: string; warnings: string[] }> {
  const { profile, data, kind } = input;
  if (!(profile.widthMm >= 20 && profile.widthMm <= 120) || !(profile.heightMm >= 20 && profile.heightMm <= 200)) {
    throw new Error('纸张尺寸超出标签范围');
  }
  const margin = profile.marginMm;
  const usableWidth = profile.widthMm - margin.left - margin.right;
  const usableHeight = profile.heightMm - margin.top - margin.bottom;
  if (usableWidth < 15 || usableHeight < 25) throw new Error('标签可用区域过小，无法排版');

  const manualBoard = kind === 'paperboard-manual';
  const board = kind === 'paperboard-batch';
  if (manualBoard && (Math.abs(profile.widthMm - 70) >= 0.001 || Math.abs(profile.heightMm - 100) >= 0.001)) {
    throw new Error('手填纸板标签仅支持 70 × 100 mm 纸张');
  }
  if (manualBoard) return buildLargePaperboardLabel(profile, data, true);
  if (board && Math.abs(profile.widthMm - 70) < 0.001 && Math.abs(profile.heightMm - 100) < 0.001) {
    return buildLargePaperboardLabel(profile, data);
  }
  const rows = board ? boardRows(data) : finishedRows(data);
  if (!rows.length) throw new Error('标签资料为空');
  const url = text(board ? ('batchUrl' in data ? data.batchUrl : '') : ('productUrl' in data ? data.productUrl : ''));
  const warnings: string[] = [];
  if (!url.startsWith(`https://youxishen.online/#/pages/label-resolver/index?v=1&kind=${kind}&id=`)) {
    warnings.push('二维码链接与当前标签记录不一致，已停止打印');
  }
  const headline = board && 'boardLength' in data
    ? `${decimal(data.boardLength)} × ${decimal(data.boardWidth)} cm`
    : 'name' in data ? text(data.name) : '';
  if (!headline) warnings.push('标签主标题为空');

  const qrSize = Math.min(26, Math.max(18, usableWidth * 0.34));
  const qr = url.startsWith('https://') && !warnings.length
    ? await QRCode.toDataURL(url, {
      errorCorrectionLevel: 'M', margin: 4, width: Math.round(qrSize * 12),
      color: { dark: '#000000ff', light: '#ffffffff' }
    })
    : '';

  const kindSize = Math.max(2, Math.min(3.5, usableWidth / 17));
  const headlineSize = Math.max(3.2, Math.min(8, usableWidth / (board ? 9 : 7)));
  const rowSize = Math.max(2.1, Math.min(3.25, usableWidth / 22));
  const rowHeight = rowSize * 1.55;
  const headerHeight = kindSize * 1.6 + 0.75;
  const headlineLines = Math.min(2, Math.max(1, Math.ceil(headline.length / (board ? 9 : 7))));
  const headlineHeight = headlineSize * 1.12 * headlineLines;
  const fieldsHeight = rows.length * rowHeight;
  const footHeight = qrSize + 1;
  const needed = headerHeight + 0.375 + headlineHeight + 1 + fieldsHeight + 1.25 + footHeight;
  if (needed > usableHeight) {
    warnings.push(`标签内容高度约 ${Math.round(needed)} mm，超过可用 ${Math.round(usableHeight)} mm；请关闭可选字段或换更大纸卷`);
  }

  const fields = rows.map(([label, value, key]) => {
    if (value.length > 30) warnings.push(`字段「${label}」较长，请核对是否完整显示`);
    if (!value) warnings.push(`字段「${label}」为空`);
    return `<div class="row" data-field="${esc(key)}"><span class="k">${esc(label)}</span><span class="v">${esc(value)}</span></div>`;
  }).join('');
  const meta = board ? `<div class="meta">${esc('batchId' in data ? data.batchId : '')}<br>扫码查看批次</div>`
    : `<div class="meta">ID ${esc('productId' in data ? data.productId : '')}<br>扫码查看商品</div>`;

  const html = `<!doctype html><html lang="zh-CN"><head><meta charset="utf-8">
<meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src 'unsafe-inline'; img-src data:; base-uri 'none'">
<style>${STYLE}
.warehouse-label{width:${mm(profile.widthMm)};height:${mm(profile.heightMm)}}
.label-body{left:${mm(margin.left)};top:${mm(margin.top)};width:${mm(usableWidth)};height:${mm(usableHeight)}}
.head{height:${mm(headerHeight)}}
.kind{font-size:${mm(kindSize)}}
.brand{font-size:${mm(kindSize * 0.7)}}
.rule{height:${mm(0.375)};margin-bottom:${mm(1)}}
.title{font-size:${mm(headlineSize)}}
.subtitle{font-size:${mm(headlineSize * 0.55)};margin-top:${mm(0.75)}}
.fields{margin-top:${mm(1.25)};font-size:${mm(rowSize)}}
.row{height:${mm(rowHeight)};line-height:${mm(rowHeight)}}
.k{width:${mm(usableWidth * 0.36)};padding-right:${mm(1)}}
.qr img{width:${mm(qrSize)};height:${mm(qrSize)}}
.meta{font-size:${mm(rowSize * 0.72)}}
</style></head><body>
<div class="warehouse-label" data-page>
  <div class="label-body" data-body>
    <div class="head"><div class="kind">${board ? '纸板批次标签' : '成品标签'}</div><div class="brand">曙光纸箱</div></div>
    <div class="rule"></div>
    <div class="title" data-title>${esc(headline)}</div>
    ${board && 'fluteType' in data ? `<div class="subtitle">${esc(text(data.fluteType))} · ${esc(text(data.supplier))}</div>` : ''}
    <div class="fields">${fields}</div>
    <div class="foot">${qr ? `<div class="qr" data-qr><img src="${qr}" alt=""></div>` : ''}${meta}</div>
  </div>
</div></body></html>`;
  return { html, warnings: [...new Set(warnings)] };
}

export const LABEL_DOTS_PER_MM = DOTS_PER_MM;
