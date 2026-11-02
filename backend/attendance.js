const STATUSES = new Set(['present', 'leave', 'absent', 'rest']);
const DATE_PATTERN = /^\d{4}-\d{2}-\d{2}$/;
const TIME_PATTERN = /^(?:[01]\d|2[0-3]):[0-5]\d$/;

const text = (value, label, maxLength, required = false) => {
  const normalized = String(value ?? '').trim();
  if (required && !normalized) throw new Error(`${label}不能为空`);
  if (normalized.length > maxLength) throw new Error(`${label}不能超过 ${maxLength} 个字符`);
  return normalized;
};

const validDate = value => {
  const normalized = text(value, '考勤日期', 10, true);
  if (!DATE_PATTERN.test(normalized)) throw new Error('考勤日期格式应为 YYYY-MM-DD');
  const parsed = new Date(`${normalized}T00:00:00Z`);
  if (Number.isNaN(parsed.getTime()) || parsed.toISOString().slice(0, 10) !== normalized) throw new Error('考勤日期无效');
  return normalized;
};

const validTime = (value, label) => {
  const normalized = text(value, label, 5);
  if (normalized && !TIME_PATTERN.test(normalized)) throw new Error(`${label}格式应为 HH:mm`);
  return normalized;
};

const normalizeInput = raw => {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) throw new Error('请提交有效的考勤记录');
  const employeeName = text(raw.employee_name, '员工姓名', 40, true);
  const date = validDate(raw.date);
  const status = text(raw.status, '考勤状态', 20, true);
  if (!STATUSES.has(status)) throw new Error('考勤状态无效');
  const clockIn = validTime(raw.clock_in, '上班时间');
  const clockOut = validTime(raw.clock_out, '下班时间');
  const overtimeValue = raw.overtime_hours === undefined || raw.overtime_hours === '' ? 0 : Number(raw.overtime_hours);
  if (!Number.isFinite(overtimeValue) || overtimeValue < 0 || overtimeValue > 24) throw new Error('加班时长应在 0 到 24 小时之间');
  return {
    employee_name: employeeName,
    date,
    status,
    clock_in: clockIn,
    clock_out: clockOut,
    overtime_hours: Math.round(overtimeValue * 100) / 100,
    note: text(raw.note, '备注', 200)
  };
};

const duplicateAt = (records, employeeName, date, ignoredId) => records.find(row =>
  row.id !== ignoredId
  && row.date === date
  && String(row.employee_name).toLowerCase() === employeeName.toLowerCase());

const list = (records = [], filters = {}) => {
  let rows = records.slice();
  if (filters.month !== undefined) {
    const month = String(filters.month);
    if (!/^\d{4}-(?:0[1-9]|1[0-2])$/.test(month)) throw new Error('月份格式应为 YYYY-MM');
    rows = rows.filter(row => row.date.startsWith(month));
  }
  if (filters.keyword) {
    const keyword = String(filters.keyword).trim().toLowerCase();
    rows = rows.filter(row => String(row.employee_name).toLowerCase().includes(keyword));
  }
  return rows
    .sort((left, right) => right.date.localeCompare(left.date) || right.updated_at - left.updated_at || right.id - left.id)
    .map(row => JSON.parse(JSON.stringify(row)));
};

const create = (records, meta, raw) => {
  const input = normalizeInput(raw);
  if (duplicateAt(records, input.employee_name, input.date)) throw Object.assign(new Error('该员工当天已有考勤记录，请直接修改原记录'), { status: 409 });
  const now = Date.now();
  const record = { id: meta.nextAttendanceId++, ...input, created_at: now, updated_at: now };
  records.push(record);
  return JSON.parse(JSON.stringify(record));
};

const update = (records, id, raw) => {
  const record = records.find(row => row.id === Number(id));
  if (!record) throw Object.assign(new Error('考勤记录不存在'), { status: 404 });
  const input = normalizeInput(raw);
  if (duplicateAt(records, input.employee_name, input.date, record.id)) throw Object.assign(new Error('该员工当天已有考勤记录'), { status: 409 });
  Object.assign(record, input, { updated_at: Date.now() });
  return JSON.parse(JSON.stringify(record));
};

const remove = (records, id) => {
  const index = records.findIndex(row => row.id === Number(id));
  if (index < 0) throw Object.assign(new Error('考勤记录不存在'), { status: 404 });
  const [record] = records.splice(index, 1);
  return JSON.parse(JSON.stringify(record));
};

const validateRecords = records => {
  if (!Array.isArray(records)) throw new Error('考勤数据表格式无效');
  const seen = new Set();
  for (const row of records) {
    const id = Number(row?.id);
    if (!Number.isSafeInteger(id) || id <= 0 || seen.has(id)) throw new Error('考勤记录存在重复或无效编号');
    seen.add(id);
    const input = normalizeInput(row);
    if (duplicateAt(records.filter(item => item !== row), input.employee_name, input.date, id)) throw new Error(`考勤记录 ${id} 与同日同员工记录重复`);
    for (const field of ['created_at', 'updated_at']) {
      if (!Number.isSafeInteger(Number(row[field])) || Number(row[field]) < 0) throw new Error(`考勤记录 ${id} 时间戳无效`);
    }
  }
};

module.exports = { STATUSES, list, create, update, remove, validateRecords };
