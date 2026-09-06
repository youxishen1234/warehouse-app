// 时间格式化
export function formatTime(ts: number): string {
  const d = new Date(ts);
  const pad = (n: number) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}`;
}

// 短时间（月/日 时:分）
export function formatShortTime(ts: number): string {
  const d = new Date(ts);
  const pad = (n: number) => String(n).padStart(2, '0');
  return `${pad(d.getMonth() + 1)}/${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}`;
}

// 金额格式化
export function formatMoney(n: number): string {
  return '¥' + Number(n).toLocaleString('zh-CN', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
}

// 库存状态
export function getStockStatus(stock: number, safety: number): { label: string; color: string } {
  if (stock === 0) return { label: '缺货', color: '#dc2626' };
  if (stock <= safety) return { label: '偏低', color: '#d97706' };
  return { label: '正常', color: '#16a34a' };
}
