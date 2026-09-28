const DAY_MS = 86400000;

function formatLocalDate(date) {
  const pad = value => String(value).padStart(2, '0');
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}`;
}

function parseDateQuery(value, endOfDay = false) {
  if (typeof value !== 'string' || value.length === 0) throw new Error('日期查询参数不能为空');
  if (/^\d+$/.test(value)) {
    const timestamp = Number(value);
    if (!Number.isSafeInteger(timestamp) || !Number.isFinite(new Date(timestamp).getTime())) throw new Error('日期查询参数必须是有效的毫秒时间戳或 YYYY-MM-DD');
    return endOfDay ? timestamp + DAY_MS - 1 : timestamp;
  }
  if (!/^\d{4}-\d{2}-\d{2}$/.test(value)) throw new Error('日期查询参数必须是有效的毫秒时间戳或 YYYY-MM-DD');
  const date = new Date(`${value}T00:00:00`);
  if (!Number.isFinite(date.getTime()) || formatLocalDate(date) !== value) throw new Error('日期查询参数必须是有效的毫秒时间戳或 YYYY-MM-DD');
  if (!endOfDay) return date.getTime();
  // Add a local calendar day instead of a fixed 24-hour duration. This keeps
  // YYYY-MM-DD filters correct across daylight-saving transitions.
  const next = new Date(date.getTime());
  next.setDate(next.getDate() + 1);
  return next.getTime() - 1;
}

module.exports = { DAY_MS, parseDateQuery };
