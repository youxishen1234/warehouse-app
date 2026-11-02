/* eslint-disable react/forbid-elements */
import { useCallback, useEffect, useRef, useState } from 'react';
import Taro, { usePullDownRefresh } from '@tarojs/taro';
import { DemoField, DemoPage, DemoSheet } from '@/components/DemoUI';
import Icon from '@/components/Icon';
import { session, watchSession } from '@/services/session';
import {
  addAttendance,
  AttendanceInput,
  AttendanceRecord,
  AttendanceStatus,
  deleteAttendance,
  getAttendance,
  updateAttendance
} from '@/services/api';
import styles from './index.module.scss';

const STATUS_OPTIONS: Array<{ value: AttendanceStatus; label: string; short: string }> = [
  { value: 'present', label: '正常出勤', short: '出勤' },
  { value: 'leave', label: '请假', short: '请假' },
  { value: 'absent', label: '缺勤', short: '缺勤' },
  { value: 'rest', label: '休息', short: '休息' }
];

const statusLabel = (status: AttendanceStatus) => STATUS_OPTIONS.find(item => item.value === status)?.short || status;
const statusClass = (status: AttendanceStatus) => ({
  present: styles.statusPresent,
  leave: styles.statusLeave,
  absent: styles.statusAbsent,
  rest: styles.statusRest
})[status];

const localDate = (date = new Date()) => {
  const year = date.getFullYear();
  const month = String(date.getMonth() + 1).padStart(2, '0');
  const day = String(date.getDate()).padStart(2, '0');
  return `${year}-${month}-${day}`;
};

const moveMonth = (month: string, delta: number) => {
  const [year, value] = month.split('-').map(Number);
  const next = new Date(Date.UTC(year, value - 1 + delta, 1));
  return `${next.getUTCFullYear()}-${String(next.getUTCMonth() + 1).padStart(2, '0')}`;
};

const monthLabel = (month: string) => {
  const [year, value] = month.split('-');
  return `${year}年${Number(value)}月`;
};

const weekdayLabel = (date: string) => ['周日', '周一', '周二', '周三', '周四', '周五', '周六'][new Date(`${date}T00:00:00Z`).getUTCDay()];

const durationHours = (record: AttendanceRecord) => {
  if (!record.clock_in || !record.clock_out) return 0;
  const minutes = (value: string) => {
    const [hour, minute] = value.split(':').map(Number);
    return hour * 60 + minute;
  };
  let span = minutes(record.clock_out) - minutes(record.clock_in);
  if (span < 0) span += 24 * 60;
  if (span === 0) return 0;
  return Math.round((span / 60) * 10) / 10;
};

const emptyForm = (date: string, employeeName = ''): AttendanceInput => ({
  employee_name: employeeName,
  date,
  status: 'present',
  clock_in: '',
  clock_out: '',
  overtime_hours: 0,
  note: ''
});

export default function Attendance() {
  const today = localDate();
  const [month, setMonth] = useState(today.slice(0, 7));
  const [records, setRecords] = useState<AttendanceRecord[]>([]);
  const [loading, setLoading] = useState(true);
  const [sessionReady, setSessionReady] = useState(Boolean(session()));
  const [error, setError] = useState('');
  const [filter, setFilter] = useState<'all' | AttendanceStatus>('all');
  const [editorOpen, setEditorOpen] = useState(false);
  const [editingId, setEditingId] = useState<number | null>(null);
  const [form, setForm] = useState<AttendanceInput>(emptyForm(today));
  const [saving, setSaving] = useState(false);
  const [formError, setFormError] = useState('');
  const requestId = useRef(0);

  useEffect(() => watchSession(() => setSessionReady(Boolean(session()))), []);

  const load = useCallback(async () => {
    const current = ++requestId.current;
    setLoading(true);
    setError('');
    try {
      const rows = await getAttendance({ month });
      if (current === requestId.current) setRecords(rows);
    } catch (loadError) {
      if (current === requestId.current) setError(loadError instanceof Error ? loadError.message : '考勤加载失败，请重试');
    } finally {
      if (current === requestId.current) setLoading(false);
    }
  }, [month]);

  useEffect(() => {
    if (sessionReady) void load();
  }, [load, sessionReady]);
  usePullDownRefresh(() => load().finally(() => Taro.stopPullDownRefresh()));

  const employees = Array.from(new Set(records.map(record => record.employee_name))).sort((left, right) => left.localeCompare(right, 'zh-CN'));
  const visibleRecords = filter === 'all' ? records : records.filter(record => record.status === filter);
  const presentRecords = records.filter(record => record.status === 'present');
  const totalHours = Math.round(presentRecords.reduce((sum, record) => sum + durationHours(record), 0) * 10) / 10;
  const overtimeHours = Math.round(records.reduce((sum, record) => sum + Number(record.overtime_hours || 0), 0) * 10) / 10;
  const attendancePeople = new Set(presentRecords.map(record => record.employee_name)).size;
  const groups = visibleRecords.reduce<Record<string, AttendanceRecord[]>>((result, record) => {
    (result[record.date] ||= []).push(record);
    return result;
  }, {});

  const openCreate = () => {
    const savedEmployee = String(Taro.getStorageSync('sg_attendance_employee') || '').trim();
    const date = month === today.slice(0, 7) ? today : `${month}-01`;
    setEditingId(null);
    setForm(emptyForm(date, savedEmployee));
    setFormError('');
    setEditorOpen(true);
  };

  const openEdit = (record: AttendanceRecord) => {
    setEditingId(record.id);
    setForm({
      employee_name: record.employee_name,
      date: record.date,
      status: record.status,
      clock_in: record.clock_in,
      clock_out: record.clock_out,
      overtime_hours: record.overtime_hours,
      note: record.note
    });
    setFormError('');
    setEditorOpen(true);
  };

  const closeEditor = () => {
    if (!saving) setEditorOpen(false);
  };

  const save = async () => {
    if (saving) return;
    if (!form.employee_name.trim()) {
      setFormError('请填写员工姓名');
      return;
    }
    if (form.overtime_hours < 0 || form.overtime_hours > 24) {
      setFormError('加班时长应在 0 到 24 小时之间');
      return;
    }
    if (form.clock_in && form.clock_out && form.clock_in === form.clock_out) {
      setFormError('上班和下班时间不能相同');
      return;
    }
    setSaving(true);
    setFormError('');
    try {
      if (editingId == null) await addAttendance(form);
      else await updateAttendance(editingId, form);
      Taro.setStorageSync('sg_attendance_employee', form.employee_name.trim());
      setEditorOpen(false);
      Taro.showToast({ title: editingId == null ? '考勤已记录' : '考勤已更新', icon: 'success' });
      if (form.date.slice(0, 7) !== month) setMonth(form.date.slice(0, 7));
      else await load();
    } catch (saveError) {
      setFormError(saveError instanceof Error ? saveError.message : '保存失败，请重试');
    } finally {
      setSaving(false);
    }
  };

  const remove = async (record: AttendanceRecord) => {
    const result = await Taro.showModal({
      title: '删除考勤记录',
      content: `确定删除 ${record.employee_name} ${record.date} 的考勤吗？`,
      confirmText: '删除',
      confirmColor: '#c44949'
    });
    if (!result.confirm) return;
    try {
      await deleteAttendance(record.id);
      Taro.showToast({ title: '已删除', icon: 'success' });
      await load();
    } catch (deleteError) {
      Taro.showToast({ title: deleteError instanceof Error ? deleteError.message : '删除失败', icon: 'none' });
    }
  };

  return <DemoPage
    title='考勤'
    subtitle='按天记录出勤、工时和加班，自动汇总到当前月份'
    className={styles.page}
    action={<button type='button' className={styles.headerAction} onClick={openCreate}><span>＋</span>记一笔</button>}
  >
    <section className={styles.monthBar} aria-label='考勤月份'>
      <button type='button' className={styles.monthArrow} aria-label='上个月' onClick={() => setMonth(moveMonth(month, -1))}>‹</button>
      <button type='button' className={styles.monthLabel} title='回到当前月份' onClick={() => setMonth(today.slice(0, 7))}>{monthLabel(month)}</button>
      <button type='button' className={styles.monthArrow} aria-label='下个月' onClick={() => setMonth(moveMonth(month, 1))}>›</button>
    </section>

    <section className={styles.summary} aria-label='本月考勤汇总'>
      <div className={styles.summaryPrimary}><Icon name='clock' color='#ffffff' className={styles.summaryClock} /><div><small>本月出勤人数</small><strong>{attendancePeople}<em>人</em></strong></div></div>
      <div className={styles.summaryItem}><small>在岗工时</small><strong>{totalHours}<em>小时</em></strong></div>
      <div className={styles.summaryItem}><small>加班时长</small><strong>{overtimeHours}<em>小时</em></strong></div>
      <div className={styles.summaryItem}><small>考勤记录</small><strong>{records.length}<em>条</em></strong></div>
    </section>

    <div className={styles.toolbar}>
      <div className={styles.filters} role='group' aria-label='筛选考勤状态'>
        {([['all', '全部'], ...STATUS_OPTIONS.map(item => [item.value, item.short])] as Array<['all' | AttendanceStatus, string]>).map(([value, label]) =>
          <button key={value} type='button' aria-pressed={filter === value} className={filter === value ? styles.filterActive : ''} onClick={() => setFilter(value)}>{label}</button>
        )}
      </div>
      <button type='button' className={styles.refresh} aria-label='刷新考勤' onClick={() => void load()} disabled={loading}>刷新</button>
    </div>

    {error && <div className={styles.error} role='alert'>{error}<button type='button' onClick={() => void load()}>重试</button></div>}
    {loading && !records.length ? <div className={styles.loading}>正在读取考勤…</div> : null}
    {!loading && !error && !visibleRecords.length ? <div className={styles.empty}>
      <div className={styles.emptyIcon}><Icon name='clock' color='#7a91b5' /></div>
      <strong>{records.length ? '这个筛选下没有记录' : '本月还没有考勤'}</strong>
      <span>{records.length ? '换个状态看看，或继续记一笔。' : '先记下第一位员工的到岗时间。'}</span>
      <button type='button' onClick={openCreate}>＋ 记一笔</button>
    </div> : null}

    {Object.entries(groups).map(([date, rows]) => <section className={styles.dayGroup} key={date}>
      <div className={styles.dayHeading}><strong>{date.slice(5).replace('-', '月') + '日'}</strong><span>{weekdayLabel(date)} · {rows.length} 条</span></div>
      <div className={styles.recordHeader} aria-hidden='true'><span>员工</span><span>状态</span><span>到岗时间</span><span>工时</span><span>加班</span><span>备注</span><span /></div>
      {rows.map(record => <article className={styles.record} key={record.id} data-testid={`attendance-record-${record.id}`}>
        <div className={styles.person}><span className={styles.avatar}>{record.employee_name.slice(0, 1)}</span><div><strong>{record.employee_name}</strong><small>{date}</small></div></div>
        <span className={`${styles.status} ${statusClass(record.status)}`}>{statusLabel(record.status)}</span>
        <div className={styles.time}>{record.clock_in || record.clock_out ? <><strong>{record.clock_in || '未填'}–{record.clock_out || '未填'}</strong><small>{record.clock_in && record.clock_out ? '上下班时间' : '时间未补全'}</small></> : <span className={styles.muted}>未填写</span>}</div>
        <div className={styles.hours}><strong>{durationHours(record) ? `${durationHours(record)}h` : '—'}</strong><small>在岗</small></div>
        <div className={styles.overtime}><strong>{Number(record.overtime_hours) ? `${Number(record.overtime_hours)}h` : '—'}</strong><small>加班</small></div>
        <div className={styles.note}>{record.note || <span className={styles.muted}>无备注</span>}</div>
        <div className={styles.actions}>
          <button type='button' aria-label={`编辑 ${record.employee_name} 的考勤`} onClick={() => openEdit(record)}>编辑</button>
          <button type='button' className={styles.delete} aria-label={`删除 ${record.employee_name} 的考勤`} onClick={() => void remove(record)}>删除</button>
        </div>
      </article>)}
    </section>)}

    {editorOpen && <DemoSheet title={editingId == null ? '记录考勤' : '修改考勤'} busy={saving} onClose={closeEditor} testId='attendance-editor'>
      <div className={styles.form}>
        <DemoField label='员工姓名'>
          <input aria-label='员工姓名' list='attendance-employees' value={form.employee_name} disabled={saving} maxLength={40} placeholder='输入姓名' onChange={event => setForm({ ...form, employee_name: event.target.value })} />
        </DemoField>
        <datalist id='attendance-employees'>{employees.map(name => <option key={name} value={name} />)}</datalist>
        <DemoField label='考勤日期'>
          <input aria-label='考勤日期' type='date' value={form.date} disabled={saving} onChange={event => setForm({ ...form, date: event.target.value })} />
        </DemoField>
        <div className={styles.formLabel}>考勤状态</div>
        <div className={styles.statusPicker} role='group' aria-label='考勤状态'>
          {STATUS_OPTIONS.map(item => <button key={item.value} type='button' aria-pressed={form.status === item.value} className={form.status === item.value ? styles.statusPickerActive : ''} disabled={saving} onClick={() => setForm({ ...form, status: item.value })}>{item.label}</button>)}
        </div>
        <div className={styles.formGrid}>
          <DemoField label='上班时间'>
            <input aria-label='上班时间' type='time' value={form.clock_in} disabled={saving} onChange={event => setForm({ ...form, clock_in: event.target.value })} />
          </DemoField>
          <DemoField label='下班时间'>
            <input aria-label='下班时间' type='time' value={form.clock_out} disabled={saving} onChange={event => setForm({ ...form, clock_out: event.target.value })} />
          </DemoField>
        </div>
        <DemoField label='加班时长（小时）'>
          <input aria-label='加班时长' type='number' inputMode='decimal' min='0' max='24' step='0.5' value={form.overtime_hours} disabled={saving} onChange={event => setForm({ ...form, overtime_hours: Number(event.target.value) || 0 })} />
        </DemoField>
        <DemoField label='备注'>
          <textarea aria-label='考勤备注' maxLength={200} value={form.note} disabled={saving} placeholder='例如：临时调班、迟到原因' onChange={event => setForm({ ...form, note: event.target.value })} />
        </DemoField>
        {formError && <div className={styles.formError} role='alert'>{formError}</div>}
        <button type='button' className='demo-primary' disabled={saving} onClick={() => void save()}>{saving ? '正在保存…' : editingId == null ? '保存考勤' : '保存修改'}</button>
      </div>
    </DemoSheet>}
  </DemoPage>;
}
