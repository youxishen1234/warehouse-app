// 时间格式化
export function formatTime(ts: number): string {
  const d = new Date(ts);
  if (!Number.isFinite(Number(ts)) || Number.isNaN(d.getTime())) return '时间未知';
  const pad = (n: number) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}`;
}

// 短时间（月/日 时:分）
export function formatShortTime(ts: number): string {
  const d = new Date(ts);
  if (!Number.isFinite(Number(ts)) || Number.isNaN(d.getTime())) return '时间未知';
  const pad = (n: number) => String(n).padStart(2, '0');
  return `${pad(d.getMonth() + 1)}/${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}`;
}

// 金额格式化
export function formatMoney(n: number): string {
  const value = Number(n);
  if (!Number.isFinite(value)) return '¥0.00';
  return '¥' + value.toLocaleString('zh-CN', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
}

export function formatMoneyPreview(n: number): string {
  const value = Number(n);
  return Number.isFinite(value) ? formatMoney(value) : '¥--';
}

// Numeric form fields cannot contain a currency sign or grouping separators.
export function formatMoneyInput(n: number): string {
  const value = Number(n);
  return Number.isFinite(value) ? value.toFixed(2) : '0.00';
}

// 库存状态
export function getStockStatus(stock: number, safety: number): { label: string; color: string } {
  if (Number(stock) <= 0) return { label: '缺货', color: '#dc2626' };
  if (Number(safety) <= 0) return { label: '正常', color: '#16a34a' };
  if (stock <= safety) return { label: '偏低', color: '#d97706' };
  return { label: '正常', color: '#16a34a' };
}
