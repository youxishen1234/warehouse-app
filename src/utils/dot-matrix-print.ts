import type { Transaction } from '@/types';

export const PAPER_PRESETS = [
  { id: '241-140', name: '241 × 140 mm', detail: '二等分连续纸', width: 241, height: 140 },
  { id: '241-93', name: '241 × 93 mm', detail: '三等分连续纸', width: 241, height: 93 },
  { id: '241-279', name: '241 × 279 mm', detail: '整张连续纸', width: 241, height: 279 },
  { id: 'a4', name: '210 × 297 mm', detail: 'A4 单张纸', width: 210, height: 297 },
] as const;

export interface DotMatrixSettings {
  template: 'blank' | 'preprinted-outbound' | 'outbound-four' | 'delivery-note';
  formTitle: string;
  paper: string;
  width: number;
  height: number;
  company: string;
  fontSize: number;
  rowsPerPage: number;
  offsetX: number;
  offsetY: number;
  showPrices: boolean;
  highClarity: boolean;
}

export const DEFAULT_PRINT_SETTINGS: DotMatrixSettings = {
  template: 'outbound-four', formTitle: '东光县曙光纸箱包装出库单', paper: '241-93', width: 241, height: 93, company: '东光县曙光纸箱包装',
  fontSize: 10, rowsPerPage: 4, offsetX: 0, offsetY: 0, showPrices: true, highClarity: true,
};

export function normalizePrintSettings(value: unknown): DotMatrixSettings {
  const source = value && typeof value === 'object' ? value as Partial<DotMatrixSettings> : {};
  const number = (key: keyof DotMatrixSettings, min: number, max: number) => {
    const v = source[key];
    return typeof v === 'number' && Number.isFinite(v) ? Math.round(Math.min(max, Math.max(min, v)) * 10) / 10 : Number(DEFAULT_PRINT_SETTINGS[key]);
  };
  const preset = PAPER_PRESETS.find(item => item.id === source.paper);
  const highClarity = typeof source.highClarity === 'boolean' ? source.highClarity : true;
  const template = ['blank', 'preprinted-outbound', 'outbound-four', 'delivery-note'].includes(source.template || '')
    ? source.template! : DEFAULT_PRINT_SETTINGS.template;
  const fixedForm = template !== 'blank' && template !== 'delivery-note';
  const fixedPaper = template === 'outbound-four' || template === 'delivery-note' ? '241-93' : '241-140';
  const fixedHeight = template === 'outbound-four' || template === 'delivery-note' ? 93 : 140;
  const normalizedPaper = fixedForm ? fixedPaper : (preset?.id || (source.paper === 'custom' ? 'custom' : DEFAULT_PRINT_SETTINGS.paper));
  return {
    template,
    paper: normalizedPaper,
    width: fixedForm ? 241 : (preset?.width ?? (source.paper === 'custom' ? number('width', 180, 300) : DEFAULT_PRINT_SETTINGS.width)),
    height: fixedForm ? fixedHeight : (preset?.height ?? (source.paper === 'custom' ? number('height', 80, 400) : DEFAULT_PRINT_SETTINGS.height)),
    company: typeof source.company === 'string' ? source.company.slice(0, 50) : DEFAULT_PRINT_SETTINGS.company,
    // 标题尊重用户输入；未填写时才回落到默认标题（此前强制覆盖导致“标题改不动”）。
    formTitle: typeof source.formTitle === 'string' && source.formTitle.trim() ? source.formTitle.slice(0, 60) : DEFAULT_PRINT_SETTINGS.formTitle,
    fontSize: template === 'delivery-note' ? 11 : template === 'outbound-four' ? 10 : Math.round(number('fontSize', highClarity ? 10 : 9, 12)), rowsPerPage: template === 'blank' ? Math.round(number('rowsPerPage', 1, 20)) : template === 'delivery-note' ? (normalizedPaper === 'a4' ? 20 : normalizedPaper === '241-140' ? 10 : 5) : template === 'outbound-four' ? 4 : 6,
    offsetX: number('offsetX', -5, 5), offsetY: number('offsetY', -5, 5),
    showPrices: typeof source.showPrices === 'boolean' ? source.showPrices : true,
    highClarity,
  };
}

export interface PrintLine extends Transaction {
  printCode?: string;
  blank?: boolean;
}

export interface PrintDocument {
  key: string;
  number: string;
  title: string;
  party: string;
  address?: string;
  phone?: string;
  receiver?: string;
  date: string;
  orderNumber: string;
  operator: string;
  category?: string;
  formNumber?: string;
  supervisor?: string;
  warehouse?: string;
  accountant?: string;
  lines: PrintLine[];
  sample?: boolean;
}

export function transactionPrintKey(tx: Transaction): string {
  return tx.type === 'out' && tx.outbound_no ? `out:${tx.outbound_no}` : `${tx.type}:${tx.id}`;
}

export function documentFromTransactions(lines: Transaction[]): PrintDocument {
  const first = lines[0];
  if (!first) throw new Error('没有可打印的单据明细');
  if (lines.some(line => line.voided_at)) throw new Error('单据已作废，请重新选择');
  if (first.type === 'adjustment') throw new Error('盘点调整请使用流水报表打印');
  const key = transactionPrintKey(first);
  if (lines.some(line => transactionPrintKey(line) !== key || line.customer_id !== first.customer_id || line.supplier_id !== first.supplier_id)) {
    throw new Error('请选择同一张单据的明细');
  }
  if (new Set(lines.map(line => line.id)).size !== lines.length) throw new Error('单据包含重复明细，请重新加载');
  const date = new Date(first.created_at);
  return {
    key, number: first.outbound_no || `${first.type === 'out' ? 'CK' : 'RK'}-${first.id}`,
    title: first.type === 'out' ? '出 库 单' : '入 库 凭 证',
    party: (first.type === 'out' ? first.customer_name : first.supplier_name) || '未关联往来单位', address: '', phone: '', receiver: '',
    date: Number.isNaN(date.getTime()) ? '日期未记录' : `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, '0')}-${String(date.getDate()).padStart(2, '0')}`,
    orderNumber: first.order_no || '', operator: first.operator || '',
    lines: [...lines].sort((a, b) => a.id - b.id),
  };
}

export function samplePrintDocument(): PrintDocument {
  return {
    key: 'sample', number: 'TEST-001', title: '出 库 单', party: '示例客户（仅供试打）',
    date: '____年__月__日', orderNumber: '', operator: '', address: '', phone: '', receiver: '', sample: true,
    lines: [
      { id: 1, product_id: 1001, product_name: '五层瓦楞纸箱', specification: '40 × 30 × 20 cm', unit: '个', quantity: 100, unit_price: 3.5, amount: 350, remark: '检查文字与横线是否清晰', type: 'out', operator: '', created_at: 0 },
      { id: 2, product_id: 1002, product_name: '三层瓦楞纸箱', specification: '30 × 20 × 15 cm', unit: '个', quantity: 200, unit_price: 2.2, amount: 440, remark: '检查纸张撕线与走纸位置', type: 'out', operator: '', created_at: 0 },
    ],
  };
}

export function moneyUpper(value: number): string {
  if (!Number.isFinite(value) || value < 0 || value >= 1e12) return '金额超出大写支持范围';
  const digits = '零壹贰叁肆伍陆柒捌玖';
  const cents = Math.round(value * 100), integer = Math.floor(cents / 100);
  const group = (n: number) => String(n).split('').map((d, i, a) => Number(d) ? digits[Number(d)] + ['', '拾', '佰', '仟'][a.length - i - 1] : '零').join('').replace(/零+/g, '零').replace(/零$/, '');
  let whole = '';
  const groups = [integer % 10000, Math.floor(integer / 10000) % 10000, Math.floor(integer / 1e8)];
  for (let i = 2; i >= 0; i--) {
    if (groups[i]) { if (whole && groups[i] < 1000 && !whole.endsWith('零')) whole += '零'; whole += group(groups[i]) + ['', '万', '亿'][i]; }
    else if (whole && groups.slice(0, i).some(Boolean) && !whole.endsWith('零')) whole += '零';
  }
  const jiao = Math.floor(cents % 100 / 10), fen = cents % 10;
  return (whole || '零') + '元' + (jiao ? digits[jiao] + '角' : fen ? '零' : '') + (fen ? digits[fen] + '分' : jiao ? '' : '整');
}

const escapeHtml = (value: unknown) => String(value ?? '').replace(/[&<>"']/g, char => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[char]!);
const money = (value: unknown) => typeof value === 'number' && Number.isFinite(value) ? value.toFixed(2) : '—';
const totalMoney = (lines: Transaction[]) => lines.every(line => typeof line.amount === 'number' && Number.isFinite(line.amount))
  ? lines.reduce((sum, line) => sum + Math.round(line.amount! * 100), 0) / 100 : null;

function preprintedDate(value: string): string {
  const match = value.match(/^(\d{4})-(\d{2})-(\d{2})$/);
  return match ? `${match[1]} 年 ${match[2]} 月 ${match[3]} 日` : value;
}

function quantities(lines: Transaction[]): string {
  const units = new Map<string, number>();
  lines.forEach(line => { const unit = line.unit || '（单位未记录）'; units.set(unit, (units.get(unit) || 0) + line.quantity); });
  return [...units].map(([unit, quantity]) => `${Number(quantity.toFixed(6))} ${unit}`).join(' / ');
}

function buildFourRowForm(doc: PrintDocument, settings: DotMatrixSettings): string {
  const e = escapeHtml;
  const displaySpecification = (value: unknown) => String(value ?? '').replace(/\s*cm\b/gi, '').trim();
  const delivery = settings.template === 'delivery-note';
  const rowCount = delivery ? 5 : 4;
  const compact = settings.height <= 100;
  const contentWidth = Math.min(170, settings.width - 30);
  const side = ((delivery ? Math.min(203.2, settings.width) : settings.width) - contentWidth) / 2;
  const rightSide = settings.width - side - contentWidth;
  const rowHeight = delivery ? (compact ? 6.4 : 8.2) : (compact ? 9 : 10.5);
  const columns = delivery ? [7.9, 20.5, 9.9, 8.1, 8.7, 8.1, 14.8, 22] : [8, 21, 19, 5, 10, 8, 11, 18];
  const headings = delivery ? ['编号', '产品名称', '规格尺寸', '单位', '数量', '单价', '金额', '备注'] : ['编号', '名称', '规格', '单位', '出库数量', '单价', '金额', '备注'];
  const count = Math.max(1, Math.ceil(doc.lines.length / rowCount));
  const sections = Array.from({ length: count }, (_, page) => {
    const pageLines = doc.lines.slice(page * rowCount, page * rowCount + rowCount);
    const meaningfulLines = pageLines.filter(line => !line.blank);
    const total = totalMoney(meaningfulLines);
    const rows = Array.from({ length: rowCount }, (_unused, index) => {
      const line = pageLines[index];
      const cells = line && !line.blank ? [line.printCode ?? (delivery ? page * rowCount + index + 1 : line.product_id), line.product_name || '', displaySpecification(line.specification), line.unit || '', line.quantity,
        settings.showPrices ? money(line.unit_price) : '', settings.showPrices ? money(line.amount) : '', line.remark || ''] : Array(8).fill('');
      return `<tr${line && !line.blank ? ` data-line="${page * rowCount + index}"` : ''}>${cells.map(value => `<td><div class="four-cell">${e(value)}</div></td>`).join('')}</tr>`;
    }).join('');
    const header = delivery
      ? `<header class="four-header delivery-header"><h1>${e(settings.company)}</h1><h2>出库单</h2></header>
<div class="delivery-meta"><div><b>收货单位：</b><span>${e(doc.party)}</span></div><div><b>送货日期：</b><span>${e(preprintedDate(doc.date))}</span></div></div>
<div class="delivery-meta delivery-submeta"><div><b>收件地址：</b><span>${e(doc.address || '')}</span></div><div><b>联系电话：</b><span>${e(doc.phone || '')}</span></div></div>`
      : `<header class="four-header"><h1>${e(settings.formTitle)}</h1><div class="four-number">No ${e(doc.formNumber || doc.number)}${count > 1 ? ` · ${page + 1}/${count}` : ''}</div></header>
<div class="four-meta"><div><b>单位：</b><span>${e(doc.party)}</span></div><div class="four-date">${e(preprintedDate(doc.date))}</div><div><b>类别：</b><span>${e(doc.category || '')}</span></div><div><b>编号：</b><span>${e(doc.orderNumber)}</span></div></div>`;
    const totalMarkup = delivery
      ? `<div class="four-total delivery-total"><b>合计：人民币大写</b><span class="four-upper">${settings.showPrices && meaningfulLines.length ? total === null ? '金额未完整记录' : e(moneyUpper(total)) : ''}</span><b>合计：</b><span class="four-amount">${settings.showPrices && meaningfulLines.length ? '￥ ' + (total === null ? '未记录' : money(total)) : ''}</span></div>`
      : `<div class="four-total"><b>合计金额<br>（大写）</b><span class="four-upper">${settings.showPrices && meaningfulLines.length ? total === null ? '金额未完整记录' : e(moneyUpper(total)) : ''}</span><span class="four-amount">${settings.showPrices && meaningfulLines.length ? '￥ ' + (total === null ? '未记录' : money(total)) : ''}</span></div>`;
    const signatures = delivery
      ? `<div class="four-signatures delivery-signatures"><div><b>收货人：</b><span class="signature-line">${e(doc.receiver || '')}</span></div><div><b>送货人：</b><span class="signature-line">${e(doc.operator)}</span></div></div>`
      : `<div class="four-signatures"><div><b>主管：</b>${e(doc.supervisor || '')}</div><div><b>仓库：</b>${e(doc.warehouse || '')}</div><div><b>记账：</b>${e(doc.accountant || '')}</div><div><b>经手人：</b>${e(doc.operator)}</div></div>`;
    return `<section class="sheet four-sheet"><div class="four-form">
${header}
<table aria-label="${delivery ? '三等分送货明细' : '四格出库明细'}"><colgroup>${columns.map(value => `<col style="width:${value}%">`).join('')}</colgroup><thead><tr>${headings.map(value => `<th>${value}</th>`).join('')}</tr></thead><tbody>${rows}</tbody></table>
${totalMarkup}
${signatures}
${delivery ? '<div class="delivery-copies">本单一式三联：第一联（白）存根联；第二联（蓝）备查联；第三联（红）客户留存联</div>' : ''}
${count > 1 ? `<div class="four-page">第 ${page + 1} / ${count} 页 · 合计为本页金额</div>` : ''}</div></section>`;
  }).join('');
  return `<!doctype html><html lang="zh-CN"><head><meta charset="utf-8"><meta name="color-scheme" content="light"><title>${e(settings.formTitle)} · ${e(doc.number)}</title><style>
*{box-sizing:border-box}html,body{margin:0;padding:0;color:#000;background:#e6e8eb;font-family:${delivery ? '"SimSun","宋体","Noto Serif CJK SC",serif' : '"Noto Sans SC","Microsoft YaHei UI","Microsoft YaHei","微软雅黑",sans-serif'};font-size:${settings.fontSize}pt;font-weight:400;font-synthesis:none;color-scheme:light}
@page{size:${settings.width}mm ${settings.height}mm;margin:0}.sheet{position:relative;width:${settings.width}mm;height:${settings.height - 0.2}mm;margin:12px;background:#fff;break-after:page;page-break-after:always}.sheet:last-child{break-after:auto;page-break-after:auto}
.four-form{position:absolute;left:${side + settings.offsetX}mm;right:${rightSide - settings.offsetX}mm;top:${(delivery ? 2 : compact ? 3 : 7) + settings.offsetY}mm}.four-header h1{margin:0;text-align:center;font-size:${delivery ? 15 : compact ? 17 : 18}pt;line-height:${delivery ? 1.2 : compact ? 1.25 : 1.35};font-weight:500;letter-spacing:${delivery ? '.5mm' : '.35mm'};overflow-wrap:anywhere;padding-bottom:${delivery ? .1 : compact ? .4 : .8}mm}.four-header h2{margin:0;text-align:center;font-size:11pt;line-height:1.1;font-weight:500}.four-number{text-align:right;font-size:${compact ? 8 : 9}pt;line-height:1.1;margin:${compact ? '.5mm 0 .5mm' : '1.2mm 0 1.5mm'};overflow-wrap:anywhere}
.four-meta{display:grid;grid-template-columns:35% 35% 15% 15%;align-items:end;font-size:${compact ? 8.5 : 9.5}pt;line-height:1.3;padding-bottom:1.5mm;gap:0}.four-meta>div{min-width:0;overflow-wrap:anywhere;padding-right:1mm}.four-meta b{font-weight:500}.four-date{text-align:center}
table{width:100%;table-layout:fixed;border-collapse:collapse;border:.14mm solid #000}th,td{border:.14mm solid #000;padding:0;vertical-align:middle}th{font-size:${delivery ? 8.5 : compact ? 8 : 9}pt;font-weight:500;height:${delivery ? 5 : compact ? 4.8 : 8}mm;line-height:1.1;text-align:center;white-space:nowrap}tbody tr{height:${rowHeight}mm;break-inside:avoid}.four-cell{padding:${delivery ? '.1' : compact ? '.2' : '.7'}mm .55mm;max-height:${rowHeight}mm;line-height:${delivery ? 1.1 : compact ? 1.2 : 1.22};overflow-wrap:anywhere;white-space:pre-wrap;text-align:center;font-size:${delivery ? 8.5 : compact ? Math.min(10, settings.fontSize) : settings.fontSize}pt}td:nth-child(2) .four-cell,td:last-child .four-cell{text-align:left}td:nth-child(3) .four-cell{font-size:${delivery ? 8 : compact ? 9 : settings.fontSize}pt;padding-left:.2mm;padding-right:.2mm}td:last-child .four-cell{font-size:${delivery ? 8 : compact ? 9 : settings.fontSize}pt;line-height:${delivery ? 1.15 : 1.3}}
.four-total{display:grid;grid-template-columns:20% 1fr auto;align-items:center;border:.14mm solid #000;border-top:0;min-height:${compact ? 7 : 11}mm;font-size:${compact ? 8.5 : 10}pt;line-height:1.3}.four-total>b{height:100%;display:flex;align-items:center;justify-content:center;text-align:center;border-right:.14mm solid #000;padding:.7mm;font-weight:500}.four-upper{padding:1mm 2mm;overflow-wrap:anywhere}.four-amount{padding:1mm 2mm;white-space:nowrap}
.four-signatures{display:grid;grid-template-columns:repeat(4,minmax(0,1fr));gap:2mm;margin-top:2mm;font-size:${compact ? 8.5 : 10}pt;line-height:1.3}.four-signatures>div{overflow-wrap:anywhere}.four-signatures b{font-weight:500}.four-page{margin-top:1mm;font-size:8pt;text-align:right}
.delivery-meta{display:grid;grid-template-columns:1.3fr 1fr;gap:4mm;align-items:end;font-size:8.5pt;line-height:1.2;min-height:5mm}.delivery-meta>div{min-width:0;overflow-wrap:anywhere}.delivery-submeta{grid-template-columns:1.5fr 1fr;min-height:4.5mm;padding-bottom:1mm}.delivery-total{grid-template-columns:28% 1fr 10% 25%;min-height:5.5mm;font-size:8.5pt;border:0}.delivery-total>b{padding:.4mm;font-size:8pt;border:0}.delivery-signatures{grid-template-columns:1fr 1fr;gap:20mm;margin-top:1.5mm;font-size:8.5pt}.delivery-signatures>div{white-space:nowrap}.signature-line{display:inline-block;min-width:28mm;border-bottom:.14mm solid #000;min-height:4mm}.delivery-copies{margin-top:2mm;font-size:7pt;line-height:1.2}
@media print{html,body{background:#fff}.sheet{margin:0}}
</style></head><body>${sections}</body></html>`;
}

// Matches the supplied delivery-note form. Keep this module self-contained for the native renderer.
function buildDeliveryNoteHtml(doc: PrintDocument, settings: DotMatrixSettings): string {
  const e = escapeHtml;
  const a4 = settings.paper === 'a4';
  const top = a4 ? 10 : settings.height <= 100 ? 9 : 6;
  const width = a4 ? 190 : 195;
  const priceDigits = Math.max(2, ...doc.lines.map(line => {
    const [whole, exponent = '0'] = String(line.unit_price ?? '').toLowerCase().split('e');
    return Math.max(0, (whole.split('.')[1] || '').length - Number(exponent));
  }));
  const formatPrice = (value?: number) => value == null ? '' : value.toFixed(Math.min(20, priceDigits));
  const spec = (value: unknown) => String(value ?? '').replace(/(\d)\s*(?:mm|ｍｍ|毫米)(?=\s*(?:[×xX*＊✕]|乘|$))/gi, '$1').replace(/\s*(?:[×xX*＊✕]|乘)\s*/g, '×').trim();
  const rows = doc.lines.filter(line => !line.blank).map((line, index) => `<tr data-line="${index}"><td>${index + 1}</td><td>${e(line.product_name)}</td><td class="spec"><span>${e(spec(line.specification))}</span></td><td>个</td><td class="num">${e(line.quantity)}</td><td class="num">${settings.showPrices ? e(formatPrice(line.unit_price)) : ''}</td><td class="num">${settings.showPrices ? e(money(line.amount)) : ''}</td><td class="remark">${e(line.remark)}</td></tr>`).join('');
  const total = totalMoney(doc.lines.filter(line => !line.blank));
  return `<!doctype html><html lang="zh-CN"><head><meta charset="utf-8"><meta name="color-scheme" content="light"><title>${e(doc.number)} · 送货单</title><style>
*{box-sizing:border-box}html,body{margin:0;padding:0;background:#e8ebef;color:#000;font:11pt/1.2 "Microsoft YaHei","PingFang SC",sans-serif;color-scheme:light}
@page{size:${settings.width}mm ${settings.height}mm;margin:0;@top-left{content:""}@top-center{content:""}@top-right{content:""}@bottom-left{content:""}@bottom-center{content:""}@bottom-right{content:""}}
.sheet{position:relative;width:${settings.width}mm;height:${settings.height - .2}mm;background:white;margin:12px;break-after:page;page-break-after:always}.sheet:last-child{break-after:auto;page-break-after:auto}
.delivery-content{position:absolute;left:${(a4 ? 10 : 6) + settings.offsetX}mm;top:${top + settings.offsetY}mm;width:${width}mm}
h1,h2{margin:0;text-align:center;font-weight:700;overflow-wrap:anywhere}h1{font-size:15pt;line-height:1.2;margin-bottom:.8mm;letter-spacing:1px}h2{font-size:18pt;font-weight:400;line-height:1.1;margin-bottom:1mm}
.meta{display:flex;align-items:baseline;justify-content:space-between;gap:2mm;margin-bottom:.7mm}.party{flex:1;min-width:0;overflow-wrap:anywhere}.date{white-space:nowrap}.address{overflow-wrap:anywhere;margin-bottom:.7mm}
.document{border:1.5pt solid #000}table{width:100%;border-collapse:collapse;table-layout:fixed}th,td{border:.5pt solid #000;padding:.35mm .4mm;height:5.5mm;text-align:center;overflow-wrap:anywhere}th{font-weight:700}thead th{border-top:0}th:first-child,td:first-child{border-left:0}th:last-child,td:last-child{border-right:0}tbody tr:last-child td{border-bottom:0}tr{break-inside:avoid;page-break-inside:avoid}
.spec span{display:block;white-space:nowrap;overflow-wrap:normal}.num{font-family:Consolas,"Courier New",monospace;text-align:right;padding-right:1.5mm;font-variant-numeric:tabular-nums;white-space:nowrap}.remark{text-align:left}
.total{display:flex;justify-content:space-between;align-items:baseline;gap:2mm;border-top:1.5pt solid #000;min-height:6mm;padding:.7mm 1mm}.upper{min-width:0;overflow-wrap:anywhere}.amount{white-space:nowrap;flex-shrink:0}.sign{display:grid;grid-template-columns:1fr 1fr;gap:2mm;border-top:.5pt solid #000;padding:1mm .5mm 2.5mm;min-height:8.5mm;font-size:10pt}.sign>div{display:flex;min-width:0}.sign b{font-weight:400;white-space:nowrap}.signature{flex:1;min-width:0;min-height:5mm;border-bottom:.5pt solid #000;overflow-wrap:anywhere}.page-number{font-size:8pt;text-align:right;margin-top:1mm}.page-number:empty{display:none}
@media print{html,body{background:white}.sheet{margin:0}}
</style></head><body><section class="sheet"><div class="delivery-content"><header><h1>${e(settings.company)}</h1><h2>送 货 单</h2><div class="meta"><span class="party">收货单位：${e(doc.party)}</span><span class="date">送货日期：${e(preprintedDate(doc.date))}</span></div><div class="address">收货地址：${e(doc.address || '')}</div></header>
<div class="document"><table aria-label="送货明细"><colgroup>${[6, 22, 18, 6, 9, 10, 14, 15].map(n => `<col style="width:${n}%">`).join('')}</colgroup><thead><tr>${['编号', '产品名称', '规格尺寸', '单位', '数量', '单价', '金额', '备注'].map((name, i) => `<th${i >= 4 && i <= 6 ? ' class="num"' : ''}>${name}</th>`).join('')}</tr></thead><tbody>${rows}</tbody></table>
<footer><div class="total"><span class="upper"><span data-total-label>合计：人民币大写</span> <span data-upper>${settings.showPrices && total !== null ? e(moneyUpper(total)) : ''}</span></span><span class="amount">合计：<span data-total>${settings.showPrices ? money(total) : ''}</span></span></div><div class="sign"><div><b>收货人：</b><span class="signature">${e(doc.receiver || '')}</span></div><div><b>送货人：</b><span class="signature">${e(doc.operator)}</span></div></div></footer></div><div class="page-number"></div></div></section></body></html>`;
}
function paginateDeliveryNote(document: Document, doc: PrintDocument, settings: DotMatrixSettings) {
  const original = document.querySelector<HTMLElement>('.sheet');
  if (!original) throw new Error('打印预览未加载');
  const lines = doc.lines.filter(line => !line.blank);
  const rows = Array.from(original.querySelectorAll<HTMLTableRowElement>('tbody tr[data-line]'));
  rows.forEach(row => row.remove());
  const template = original.cloneNode(true) as HTMLElement;
  const sheets = [original];
  let sheet = original;
  const updateTotal = () => {
    const pageLines = Array.from(sheet.querySelectorAll<HTMLElement>('tbody [data-line]')).map(row => lines[Number(row.dataset.line)]);
    const total = totalMoney(pageLines);
    sheet.querySelector('[data-total-label]')!.textContent = '本页合计：人民币大写';
    if (settings.showPrices) { sheet.querySelector('[data-upper]')!.textContent = total === null ? '金额未完整记录' : moneyUpper(total); sheet.querySelector('[data-total]')!.textContent = money(total); }
    // Reserve page-number space before measuring rows; the final page count can add a page.
    sheet.querySelector<HTMLElement>('.page-number')!.style.minHeight = '4mm';
    sheet.querySelector<HTMLElement>('.page-number')!.style.display = 'block';
  };
  const fits = () => { updateTotal(); return sheet.querySelector('.delivery-content')!.getBoundingClientRect().bottom <= sheet.getBoundingClientRect().bottom - 5 * 96 / 25.4; };
  const fitSpec = (row: HTMLElement) => row.querySelectorAll<HTMLElement>('.spec span').forEach(span => {
    const range = document.createRange(); range.selectNodeContents(span);
    const width = range.getBoundingClientRect().width;
    if (width > span.clientWidth) span.style.fontSize = `${Math.max(6, 11 * span.clientWidth / width)}pt`;
    if (span.scrollWidth > span.clientWidth + 1) throw new Error('规格文字过长，请缩短后打印');
  });
  for (const [index, row] of rows.entries()) {
    const body = () => sheet.querySelector('tbody')!;
    if (body().children.length >= settings.rowsPerPage) { sheet = template.cloneNode(true) as HTMLElement; document.body.appendChild(sheet); sheets.push(sheet); }
    body().appendChild(row); fitSpec(row);
    if (!fits() && body().children.length > 1) { row.remove(); updateTotal(); sheet = template.cloneNode(true) as HTMLElement; document.body.appendChild(sheet); sheets.push(sheet); body().appendChild(row); fitSpec(row); }
    if (!fits()) throw new Error(`第 ${index + 1} 行内容放不下，请选择更大的纸张或缩短备注`);
  }
  for (const [index, current] of sheets.entries()) {
    sheet = current;
    sheet.querySelectorAll<HTMLElement>('td.num').forEach(cell => {
      if (cell.scrollWidth > cell.clientWidth + 1) throw new Error('数量或金额过长，无法在纸张列内完整显示，请核对数值');
    });
    const body = sheet.querySelector('tbody')!;
    const pageLines = Array.from(body.querySelectorAll<HTMLElement>('[data-line]')).map(row => lines[Number(row.dataset.line)]);
    const total = totalMoney(pageLines);
    if (settings.showPrices) { sheet.querySelector('[data-upper]')!.textContent = total === null ? '金额未完整记录' : moneyUpper(total); sheet.querySelector('[data-total]')!.textContent = money(total); }
    if (sheets.length > 1) {
      sheet.querySelector('[data-total-label]')!.textContent = '本页合计：人民币大写';
      sheet.querySelector('.page-number')!.textContent = `第 ${index + 1} / ${sheets.length} 页 · 整单合计 ${money(totalMoney(lines))} 元`;
    }
    if (!fits()) throw new Error('合计或签字内容超出纸张，请选择更大的纸张');
    while (body.children.length < Math.min(5, settings.rowsPerPage)) {
      const row = document.createElement('tr');
      for (let i = 0; i < 8; i++) row.appendChild(document.createElement('td'));
      body.appendChild(row); if (!fits()) { row.remove(); break; }
    }
    if (sheets.length === 1) sheet.querySelector('[data-total-label]')!.textContent = '合计：人民币大写';
  }
  return { pages: sheets.length, height: document.body.scrollHeight + 12 };
}

/** A script-free, isolated document. Physical dimensions never pass through Taro's px transform. */
export function buildDotMatrixHtml(doc: PrintDocument, rawSettings: DotMatrixSettings): string {
  const settings = normalizePrintSettings(rawSettings);
  if (settings.template === 'delivery-note') return buildDeliveryNoteHtml(doc, settings);
  if (settings.template === 'outbound-four') return buildFourRowForm(doc, settings);
  const e = escapeHtml;
  const total = totalMoney(doc.lines);
  // The LQ-630K driver exposes only about 203 mm of printable width, even on
  // 241 mm paper. Keep a separate right safety margin instead of scaling text.
  const centeredThreePart = settings.paper === '241-93';
  const contentWidth = centeredThreePart ? 170 : Math.min(180, settings.width - 26);
  const sideMargin = Math.max(13, (settings.width - contentWidth) / 2);
  const rightMargin = sideMargin;
  const headings = ['货号', '名称', '规格', '单位', '数量', ...(settings.showPrices ? ['单价', '金额'] : []), '备注'];
  const widths = settings.showPrices ? [8, 17, 18, 5, 10, 10, 12, 20] : [9, 22, 22, 7, 12, 28];
  const rows = doc.lines.map((line, index) => {
    const cells = [line.product_id, line.product_name || '未记录名称', line.specification || '', line.unit || '—', line.quantity,
      ...(settings.showPrices ? [line.unit_price == null ? '—' : line.unit_price, money(line.amount)] : []), line.remark || ''];
    return `<tr data-line="${index}">${cells.map(value => `<td>${e(value)}</td>`).join('')}</tr>`;
  }).join('');
  const preprinted = settings.template === 'preprinted-outbound';
  if (preprinted) {
    // 容量校验与实际渲染行数保持一致：预印版每张渲染 6 行，超过 6 行明确报错，绝不静默丢行。
    if (doc.lines.length > 6) throw new Error(`预印套打每张固定 6 行，本单共 ${doc.lines.length} 行，请切换四格出库单或分单打印`);
    const preprintedRows = Array.from({ length: 6 }, (_unused, index) => {
      const line = doc.lines[index];
      return `<div class="pre-row"><span>${line ? e(line.product_id) : ''}</span><span>${line ? e(line.product_name || '') : ''}</span><span>${line ? e(line.specification || '') : ''}</span><span>${line ? e(line.unit || '') : ''}</span><span>${line ? e(line.quantity) : ''}</span><span>${line && settings.showPrices && line.unit_price != null ? e(line.unit_price) : ''}</span><span>${line && settings.showPrices ? e(money(line.amount)) : ''}</span><span>${line ? e(line.remark || '') : ''}</span></div>`;
    }).join('');
    const preprintedCss = `
*{box-sizing:border-box}html,body{margin:0;padding:0;background:#e8e8e8;color:#000;font-family:"Noto Sans SC","Microsoft YaHei UI","Microsoft YaHei","微软雅黑",sans-serif;font-size:10pt}
@page{size:241mm 140mm;margin:0}.sheet{position:relative;width:241mm;height:139.8mm;margin:12px;background:#fff;break-after:page;page-break-after:always}.sheet:last-child{break-after:auto}
.preprinted-guide{position:absolute;inset:0;color:#9da3aa;font-size:9pt;pointer-events:none}.guide-company{position:absolute;left:55mm;top:5mm;width:120mm;text-align:center;font-size:12pt;font-weight:600;color:#aab0b6}.guide-title{position:absolute;left:75mm;top:11mm;width:90mm;text-align:center;font-size:17pt;font-weight:600;color:#aab0b6}.guide-no{position:absolute;left:190mm;top:13mm}.guide-label{position:absolute;top:27mm}.guide-unit{left:8mm}.guide-date{left:103mm}.guide-category{left:166mm}.guide-code{left:203mm}.guide-table{position:absolute;left:5mm;top:38mm;width:231mm;height:68mm;border:.18mm dashed #aeb4ba}.guide-head{position:absolute;left:5mm;top:38mm;width:231mm;height:11mm;display:grid;grid-template-columns:13% 22% 16% 6% 11% 10% 11% 11%;align-items:center;color:#9da3aa;text-align:center}.guide-table:before{content:"";position:absolute;inset:0;background:linear-gradient(to right,transparent 13%,#aeb4ba 13%,#aeb4ba calc(13% + .18mm),transparent calc(13% + .18mm),transparent 35%,#aeb4ba 35%,#aeb4ba calc(35% + .18mm),transparent calc(35% + .18mm),transparent 51%,#aeb4ba 51%,#aeb4ba calc(51% + .18mm),transparent calc(51% + .18mm),transparent 57%,#aeb4ba 57%,#aeb4ba calc(57% + .18mm),transparent calc(57% + .18mm),transparent 68%,#aeb4ba 68%,#aeb4ba calc(68% + .18mm),transparent calc(68% + .18mm),transparent 78%,#aeb4ba 78%,#aeb4ba calc(78% + .18mm),transparent calc(78% + .18mm),transparent 89%,#aeb4ba 89%,#aeb4ba calc(89% + .18mm),transparent calc(89% + .18mm))}.guide-table:after{content:"";position:absolute;inset:11mm 0 0;background:repeating-linear-gradient(to bottom,transparent 0,transparent calc(11mm - .18mm),#aeb4ba calc(11mm - .18mm),#aeb4ba 11mm)}.guide-total{position:absolute;left:5mm;right:5mm;top:108mm;border-top:.18mm dashed #aeb4ba;padding-top:2mm;color:#aab0b6}.guide-sign{position:absolute;left:5mm;right:5mm;top:126mm;display:flex;justify-content:space-between;color:#aab0b6}.overlay{position:absolute;inset:0;font-weight:400}.field{position:absolute;white-space:nowrap;line-height:1.1}.unit{left:15mm;top:29mm;width:58mm}.date{left:104mm;top:29mm;width:42mm;text-align:center}.category{left:171mm;top:29mm;width:22mm}.code{left:203mm;top:29mm;width:25mm}.pre-table{position:absolute;left:5mm;top:39.5mm;width:231mm}.pre-row{display:grid;grid-template-columns:13% 22% 16% 6% 11% 10% 11% 11%;height:11mm;align-items:center}.pre-row span{padding:0 1mm;overflow:hidden;white-space:nowrap;text-overflow:clip}.pre-row span:nth-child(1),.pre-row span:nth-child(4),.pre-row span:nth-child(5),.pre-row span:nth-child(6),.pre-row span:nth-child(7){text-align:center}.pre-row span:nth-child(2),.pre-row span:nth-child(3),.pre-row span:nth-child(8){text-align:left}.upper{position:absolute;left:25mm;top:112mm;width:92mm;font-size:10pt;white-space:nowrap}.amount{position:absolute;left:203mm;top:112mm;width:25mm;text-align:right;font-size:10pt}.operator{position:absolute;left:26mm;top:127mm;width:35mm}.warehouse{position:absolute;left:83mm;top:127mm;width:35mm}.accountant{position:absolute;left:139mm;top:127mm;width:35mm}.handler{position:absolute;left:194mm;top:127mm;width:35mm}
@media print{html,body{background:#fff}.sheet{margin:0;box-shadow:none}.preprinted-guide{display:none}}`;
    const formattedDate = preprintedDate(doc.date);
    return `<!doctype html><html lang="zh-CN"><head><meta charset="utf-8"><meta name="color-scheme" content="light"><title>${e(doc.number)} · 预印出库单</title><style>${preprintedCss}</style></head><body><section class="sheet"><div class="preprinted-guide"><div class="guide-company">东光县曙光纸箱包装</div><div class="guide-title">出 库 单</div><div class="guide-no">No</div><div class="guide-label guide-unit">单位：</div><div class="guide-label guide-date">日期：</div><div class="guide-label guide-category">类别：</div><div class="guide-label guide-code">编号：</div><div class="guide-table"></div><div class="guide-head"><span>编号</span><span>名称</span><span>规格</span><span>单位</span><span>出库数量</span><span>单价</span><span>金额</span><span>备注</span></div><div class="guide-total">合计金额（大写）：　　　　　　　　　　　　　　　　　　　　　　￥</div><div class="guide-sign"><span>主管：</span><span>仓库：</span><span>记账：</span><span>经手人：</span></div><div class="guide-sample">${doc.sample ? '测试样张 · 不作为发货凭证' : ''}</div></div><div class="overlay"><div class="field unit">${e(doc.party)}</div><div class="field date">${e(formattedDate)}</div><div class="field category"></div><div class="field code">${e(doc.number)}</div><div class="pre-table">${preprintedRows}</div><div class="upper">${settings.showPrices ? (total === null ? '' : e(moneyUpper(total))) : ''}</div><div class="amount">${settings.showPrices ? (total === null ? '' : '￥ ' + e(money(total))) : ''}</div><div class="operator">${e(doc.operator)}</div><div class="warehouse"></div><div class="accountant"></div><div class="handler">${e(doc.operator)}</div></div></section></body></html>`;
  }
  // Use a scalable sans-serif CJK face: small SimSun/FangSong glyphs on Windows
  // become jagged bitmap text even when the page itself is shown at 100%.
  // Preview and physical printing must share this exact HTML and typeface.
  const clarityStyle = settings.highClarity ? `
html,body{font-family:"Noto Sans SC","Microsoft YaHei UI","Microsoft YaHei","微软雅黑",sans-serif;font-weight:400;font-size:${settings.fontSize}pt;color:#000;font-synthesis:none}
h1{font-family:inherit;font-weight:600;font-size:13pt}h2{font-family:inherit;font-weight:600;font-size:16pt;letter-spacing:1.5mm}
th{font-family:inherit;font-weight:500;font-size:10pt}.meta,.sample{font-size:10pt;font-weight:400;line-height:1.3}
.footer{font-size:10pt;font-weight:400;line-height:1.32}.page-number,.calibration{font-size:9pt;font-weight:400}
${settings.height <= 100 ? `.content{top:${6 + settings.offsetY}mm;bottom:${10 - settings.offsetY}mm}h1{font-size:12pt}h2{font-size:14pt}.meta{font-size:9pt;margin:0.7mm 0}.footer{font-size:9pt;line-height:1.25}.sample{font-size:9pt;margin:0.5mm 0}th{font-size:9pt;white-space:nowrap;padding:0.8mm 0.5mm}td{padding:0.8mm 1mm;line-height:1.25}.signatures{margin-top:1mm}` : ''}` : '';
  return `<!doctype html><html lang="zh-CN"><head><meta charset="utf-8"><meta name="color-scheme" content="light"><title>${e(doc.number)} · ${e(doc.title)}</title><style>
*{box-sizing:border-box}html,body{margin:0;padding:0;color:#000;background:#e6e8eb;font-family:"Noto Sans SC","Microsoft YaHei UI","Microsoft YaHei","微软雅黑",sans-serif;font-size:${settings.fontSize}pt;color-scheme:light;font-synthesis:none}
@page{size:${settings.width}mm ${settings.height}mm;margin:0}
.sheet{position:relative;width:${settings.width}mm;height:${settings.height - 0.2}mm;margin:12px;background:#fff;break-after:page;page-break-after:always;box-shadow:0 2px 8px #0001}
.sheet:last-child{break-after:auto;page-break-after:auto}.content{position:absolute;left:${sideMargin + settings.offsetX}mm;right:${rightMargin - settings.offsetX}mm;top:${10 + settings.offsetY}mm;bottom:${14 - settings.offsetY}mm}
h1{margin:0 0 1mm;text-align:center;font-size:14pt;font-weight:600;line-height:1.25;overflow-wrap:anywhere}h2{margin:0;text-align:center;font-size:17pt;font-weight:600;line-height:1.3;letter-spacing:2mm}
.meta{display:flex;justify-content:space-between;gap:4mm;margin:1.5mm 0;font-size:9pt;line-height:1.35}.meta>*{min-width:0;overflow-wrap:anywhere}.meta .party{flex:1}.sample{text-align:center;font-size:9pt;margin:1mm 0;font-weight:bold}
table{width:100%;border-collapse:collapse;table-layout:fixed;border:0.14mm solid #000}th,td{border:0.14mm solid #000;padding:1.2mm 1mm;line-height:1.28;overflow-wrap:anywhere;word-break:break-word;white-space:pre-wrap;vertical-align:middle}th{font-weight:600;text-align:center;font-size:9pt}td{height:8mm;font-weight:400;text-align:center}td:nth-child(2),td:last-child{text-align:left}tr{break-inside:avoid}
.footer{position:absolute;bottom:0;left:0;right:0;font-size:9.5pt;line-height:1.35}.total{display:flex;justify-content:space-between;gap:4mm;border-top:0.14mm solid #000;padding-top:1mm}.total>*{overflow-wrap:anywhere;min-width:0}.signatures{display:flex;justify-content:space-between;gap:3mm;margin-top:2mm}.signatures>*{min-width:0;overflow-wrap:anywhere}.page-number{position:absolute;bottom:-4mm;right:0;font-size:8pt}.calibration{position:absolute;bottom:-4mm;left:0;font-size:8pt}
${settings.height <= 100 ? 'h1{font-size:12pt}h2{font-size:15pt}.meta{font-size:8pt;margin:1mm 0}.footer{font-size:8pt;line-height:1.35}.signatures{margin-top:1mm}' : ''}
${clarityStyle}
@media print{html,body{background:#fff}.sheet{margin:0;box-shadow:none}}
</style></head><body data-rows-per-page="${settings.rowsPerPage}"><section class="sheet"><div class="content"><header><h1>${e(settings.company)}</h1><h2>${e(doc.title)}</h2>${doc.sample ? '<div class="sample">测试样张 · 不作为发货凭证</div>' : ''}<div class="meta"><span class="party">单位：${e(doc.party)}</span><span>日期：${e(doc.date)}</span></div><div class="meta"><span>编号：${e(doc.number)}</span><span>${doc.orderNumber ? `订单：${e(doc.orderNumber)}` : ''}</span></div></header>
<table aria-label="单据明细"><colgroup>${widths.map(width => `<col style="width:${width}%">`).join('')}</colgroup><thead><tr>${headings.map(label => `<th>${label}</th>`).join('')}</tr></thead><tbody>${rows}</tbody></table>
<footer class="footer"><div class="total"><span data-page-quantity>本页数量：${e(quantities(doc.lines))}</span>${settings.showPrices ? `<span data-page-amount>本页小计：${total === null ? '金额未完整记录' : '￥ ' + money(total)}</span>` : ''}</div>
${settings.showPrices ? `<div class="total"><span>整单合计（大写）：${total === null ? '金额未完整记录' : e(moneyUpper(total))}</span><span>￥ ${total === null ? '—' : money(total)}</span></div>` : `<div class="total">整单数量：${e(quantities(doc.lines))}</div>`}
<div class="signatures"><span>经手人：${e(doc.operator)}</span><span>${doc.lines[0]?.type === 'in' ? '验收人' : '客户／收货人签字'}：____________</span><span>签收日期：____________</span></div></footer>
<div class="page-number"></div>${doc.sample ? `<div class="calibration">纸张 ${settings.width} × ${settings.height} mm · 打印比例 100%</div>` : ''}</div></section></body></html>`;
}

/** Measure the actual font and wrapped rows before allowing print; never silently cut off a row. */
export function paginateDotMatrixDocument(document: Document, doc: PrintDocument, rawSettings: DotMatrixSettings): { pages: number; height: number } {
  const settings = normalizePrintSettings(rawSettings);
  if (settings.template === 'delivery-note') return paginateDeliveryNote(document, doc, settings);
  const original = document.querySelector<HTMLElement>('.sheet');
  if (!original) throw new Error('打印预览未加载，请重试');
  if (settings.template === 'outbound-four') {
    if (!settings.formTitle.trim()) throw new Error('请填写单据标题');
    const sheets = Array.from(document.querySelectorAll<HTMLElement>('.four-sheet'));
    sheets.forEach((sheet, page) => {
      const bounds = sheet.getBoundingClientRect();
      const content = sheet.querySelector<HTMLElement>('.four-form')!.getBoundingClientRect();
      if (content.bottom > bounds.bottom - 4 || content.left < bounds.left || content.right > bounds.right) throw new Error(`第 ${page + 1} 页内容超出纸张，请调整纸张或字号`);
      sheet.querySelectorAll<HTMLElement>('.four-cell').forEach(cell => {
        if (cell.scrollHeight > cell.clientHeight + 1) throw new Error('明细内容超出固定行高，请缩短本次打印文字或选择较大的纸张');
      });
    });
    return { pages: sheets.length, height: document.body.scrollHeight + 12 };
  }
  if (settings.template === 'preprinted-outbound') return { pages: 1, height: document.body.scrollHeight + 12 };
  const rows = Array.from(original.querySelectorAll<HTMLTableRowElement>('tbody tr'));
  rows.forEach(row => row.remove());
  const template = original.cloneNode(true) as HTMLElement;
  const sheets: HTMLElement[] = [original];
  let sheet = original;
  let count = 0;
  const body = () => sheet.querySelector('tbody')!;
  const fits = () => sheet.querySelector('table')!.getBoundingClientRect().bottom + 6 <= sheet.querySelector('.footer')!.getBoundingClientRect().top;
  const next = () => { sheet = template.cloneNode(true) as HTMLElement; document.body.appendChild(sheet); sheets.push(sheet); count = 0; };
  rows.forEach((row, index) => {
    if (count >= settings.rowsPerPage) next();
    body().appendChild(row);
    if (!fits() && count > 0) { row.remove(); next(); body().appendChild(row); }
    if (!fits()) throw new Error(`第 ${index + 1} 行内容超出纸张，请选择更长的纸张或调小字号后重试`);
    count++;
  });
  if (!rows.length) throw new Error('没有可打印的单据明细');
  for (const current of sheets) {
    sheet = current;
    const pageLines = Array.from(sheet.querySelectorAll<HTMLTableRowElement>('tbody tr')).map(row => doc.lines[Number(row.dataset.line)]);
    sheet.querySelector('[data-page-quantity]')!.textContent = `本页数量：${quantities(pageLines)}`;
    const amount = sheet.querySelector('[data-page-amount]');
    if (amount) { const total = totalMoney(pageLines); amount.textContent = `本页小计：${total === null ? '金额未完整记录' : '￥ ' + money(total)}`; }
    if (!fits()) throw new Error('合计或签收栏内容过长，请选择更长的纸张后重试');
    while (body().children.length < settings.rowsPerPage) {
      const blank = document.createElement('tr');
      for (let col = 0; col < (settings.showPrices ? 8 : 6); col++) blank.appendChild(document.createElement('td'));
      body().appendChild(blank);
      if (!fits()) { blank.remove(); break; }
    }
    sheet.querySelector('.page-number')!.textContent = `第 ${sheets.indexOf(sheet) + 1} / ${sheets.length} 页`;
  }
  return { pages: sheets.length, height: document.body.scrollHeight + 12 };
}

/** Print at the top-level page origin, outside the scaled preview and all app layout ancestors. */
export function mountDotMatrixPrintDocument(source: Document, rawSettings: DotMatrixSettings, target: Document): () => void {
  const settings = normalizePrintSettings(rawSettings);
  const sheets = source.querySelectorAll('.sheet');
  const sourceStyle = source.querySelector('style');
  if (!sheets.length || !sourceStyle) throw new Error('打印预览未加载，请重试');

  const root = target.createElement('div');
  root.setAttribute('data-dot-matrix-print-root', '');
  root.style.display = 'none';
  const shadow = root.attachShadow({ mode: 'open' });
  const sheetStyle = target.createElement('style');
  // Shadow DOM prevents application CSS from changing the measured table, text or footer.
  sheetStyle.textContent = `${sourceStyle.textContent}\n:host{all:initial;display:block;color:#000;background:#fff;direction:ltr;font-family:"Noto Sans SC","Microsoft YaHei UI","Microsoft YaHei","微软雅黑",sans-serif;font-weight:400;font-size:${settings.fontSize}pt;line-height:normal;color-scheme:light;font-synthesis:none}`;
  shadow.appendChild(sheetStyle);
  sheets.forEach(sheet => shadow.appendChild(target.importNode(sheet, true)));

  const pageStyle = target.createElement('style');
  pageStyle.setAttribute('data-dot-matrix-print-style', '');
  pageStyle.textContent = `@page{size:${settings.width}mm ${settings.height}mm;margin:0}
@media print{
html[data-dot-matrix-print],html[data-dot-matrix-print] body{margin:0!important;padding:0!important;width:auto!important;min-width:0!important;height:auto!important;min-height:0!important;overflow:visible!important;position:static!important;transform:none!important;background:#fff!important;color-scheme:light!important}
html[data-dot-matrix-print] body>:not([data-dot-matrix-print-root]){display:none!important}
html[data-dot-matrix-print] [data-dot-matrix-print-root]{display:block!important;position:static!important;float:none!important;transform:none!important;zoom:1!important;margin:0!important;padding:0!important;border:0!important;width:${settings.width}mm!important;height:auto!important;overflow:visible!important}
}`;
  const previousTitle = target.title;
  const previousMode = target.documentElement.getAttribute('data-dot-matrix-print');
  target.head.appendChild(pageStyle);
  target.body.appendChild(root);
  target.documentElement.setAttribute('data-dot-matrix-print', '');
  target.title = source.title;
  let removed = false;
  return () => {
    if (removed) return;
    removed = true;
    root.remove();
    pageStyle.remove();
    if (previousMode === null) target.documentElement.removeAttribute('data-dot-matrix-print');
    else target.documentElement.setAttribute('data-dot-matrix-print', previousMode);
    target.title = previousTitle;
  };
}
