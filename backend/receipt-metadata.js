'use strict';

function entryTime(value, date) {
  if (value === undefined || value === '') return undefined;
  if (typeof value !== 'string' || !/^\d{4}-\d{2}-\d{2}T(?:[01]\d|2[0-3]):[0-5]\d$/.test(value)
    || value.slice(0, 10) !== date || !Number.isFinite(Date.parse(value))) {
    throw new Error('入库日期时间无效，日期必须与业务日期一致');
  }
  return value;
}

function location(value) {
  if (value === undefined) return undefined;
  if (typeof value !== 'string' || value.length > 120 || /[\u0000-\u001f\u007f]/.test(value)) throw new Error('库位格式无效');
  return value.trim();
}

module.exports = { entryTime, location };
