const { test } = require('node:test');
const assert = require('node:assert/strict');
const express = require('express');
const install = require('./team');
const attendance = require('./attendance');

test('attendance API records one entry per employee and day with revision-safe edits', async () => {
  const state = {
    revision: 0,
    records: [],
    meta: { nextAttendanceId: 1 },
    audit: [],
    receipts: new Map()
  };
  const db = {
    revision: () => state.revision,
    health: () => ({ online: true, dataReadable: true, dataWritable: true }),
    audit: () => state.audit,
    listAttendance: filters => attendance.list(state.records, filters),
    addAttendance: raw => attendance.create(state.records, state.meta, raw),
    updateAttendance: (id, raw) => attendance.update(state.records, id, raw),
    deleteAttendance: id => attendance.remove(state.records, id),
    transact: (actor, key, fingerprint, expected, operation, action) => {
      const receiptKey = `${actor.id}:${key}`;
      if (state.receipts.has(receiptKey)) return { data: state.receipts.get(receiptKey), revision: state.revision, replayed: true };
      if (expected !== String(state.revision)) throw Object.assign(new Error('revision conflict'), { status: 409 });
      const data = action();
      state.revision += 1;
      state.audit.push({ actor_name: actor.username, operation, time: Date.now() });
      state.receipts.set(receiptKey, JSON.parse(JSON.stringify(data)));
      return { data, revision: state.revision, replayed: false };
    },
    stats: () => ({ totalProducts: 0 })
  };
  const app = express();
  app.use(express.json());
  app.use('/api', install(db));
  const server = app.listen(0, '127.0.0.1');
  await new Promise(resolve => server.once('listening', resolve));
  const base = `http://127.0.0.1:${server.address().port}/api`;
  const headers = key => ({ 'Content-Type': 'application/json', 'Idempotency-Key': key, 'If-Match': String(state.revision) });
  const body = {
    employee_name: '张三',
    date: '2026-11-01',
    status: 'present',
    clock_in: '08:00',
    clock_out: '17:30',
    overtime_hours: 1.5,
    note: '月底盘点'
  };
  try {
    const empty = await fetch(`${base}/attendance?month=2026-11`);
    assert.equal(empty.status, 200);
    assert.deepEqual((await empty.json()).data, []);

    const created = await fetch(`${base}/attendance`, { method: 'POST', headers: headers('attendance-create-0001'), body: JSON.stringify(body) });
    assert.equal(created.status, 200);
    assert.equal(created.headers.get('x-warehouse-revision'), '1');
    assert.equal((await created.json()).data.employee_name, '张三');

    const duplicate = await fetch(`${base}/attendance`, { method: 'POST', headers: headers('attendance-create-0002'), body: JSON.stringify(body) });
    assert.equal(duplicate.status, 409);

    const updatedBody = { ...body, clock_out: '18:00', overtime_hours: 2 };
    const updated = await fetch(`${base}/attendance/1`, { method: 'PUT', headers: headers('attendance-update-0001'), body: JSON.stringify(updatedBody) });
    assert.equal(updated.status, 200);
    assert.equal((await updated.json()).data.overtime_hours, 2);

    const listed = await fetch(`${base}/attendance?month=2026-11&keyword=${encodeURIComponent('张')}`);
    const rows = (await listed.json()).data;
    assert.equal(rows.length, 1);
    assert.equal(rows[0].clock_out, '18:00');

    const removed = await fetch(`${base}/attendance/1`, { method: 'DELETE', headers: headers('attendance-delete-0001') });
    assert.equal(removed.status, 200);
    assert.equal(state.records.length, 0);
    assert.equal(state.revision, 3);
  } finally {
    server.closeAllConnections();
    await new Promise(resolve => server.close(resolve));
  }
});

test('attendance backup validation rejects duplicate employee and date rows', () => {
  const row = {
    id: 1,
    employee_name: '李四',
    date: '2026-11-01',
    status: 'present',
    clock_in: '',
    clock_out: '',
    overtime_hours: 0,
    note: '',
    created_at: Date.now(),
    updated_at: Date.now()
  };
  assert.throws(() => attendance.validateRecords([row, { ...row, id: 2 }]), /重复/);
});
