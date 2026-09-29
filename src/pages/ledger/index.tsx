import { useSharedRefresh } from '@/services/shared-refresh';
import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { View, Text, Input, Picker, Button, ScrollView } from '@tarojs/components';
import Taro from '@tarojs/taro';
import { addLedger, deleteLedger, getLedger, LedgerEntry, LedgerType } from '@/services/api';
import { formatMoney, formatShortTime } from '@/utils/format';
import { downloadCsv } from '@/services/download';
import { parseMoneyInput, previewMoneyInput, sanitizeNonNegativeMoneyInput } from '@/utils/form-input';
import styles from './index.module.scss';

const types: { value: LedgerType | ''; label: string }[] = [{ value: '', label: '全部' }, { value: 'income', label: '收入' }, { value: 'expense', label: '支出' }, { value: 'receivable', label: '应收' }, { value: 'payable', label: '应付' }, { value: 'settlement', label: '结清' }];

const dayStart = (value: string) => value ? new Date(`${value}T00:00:00`).getTime() : undefined;

type LedgerListRowProps = {
  entry: LedgerEntry;
  label: string;
  onRemove: (entry: LedgerEntry) => void;
};

// Keep ledger rows out of add/edit form renders. Amount and remark inputs are
// local page state; unchanged rows can retain their DOM while the form updates.
const LedgerListRow = React.memo(function LedgerListRow({ entry, label, onRemove }: LedgerListRowProps) {
  const positive = entry.type === 'income' || entry.type === 'receivable';
  return (
    <View className={styles.item}>
      <View>
        <Text className={styles.itemTitle}>{label} · {entry.party_name || '未关联对象'}{entry.party_current_name && entry.party_current_name !== entry.party_name ? `（现名：${entry.party_current_name}）` : ''}</Text>
        <Text className={styles.remark}>{entry.remark || '无说明'} · {formatShortTime(entry.created_at)}</Text>
      </View>
      <Text className={positive ? styles.in : styles.out}>{positive ? '+' : '-'}{formatMoney(entry.amount)}</Text>
      <Text className={styles.delete} onClick={() => onRemove(entry)}>作废</Text>
    </View>
  );
});

export default function LedgerPage() {
  const [list, setList] = useState<LedgerEntry[]>([]);
  const [type, setType] = useState<LedgerType | ''>('');
  const [fromDate, setFromDate] = useState('');
  const [toDate, setToDate] = useState('');
  const [show, setShow] = useState(false);
  const [amount, setAmount] = useState('');
  const [remark, setRemark] = useState('');
  const [kind, setKind] = useState<LedgerType>('income');
  const [saving, setSaving] = useState(false);
  const [loading, setLoading] = useState(true);
  const [loadError, setLoadError] = useState('');
  const loadSequence = useRef(0);

  const load = useCallback(async () => {
    const sequence = ++loadSequence.current;
    setLoading(true);
    setLoadError('');
    if (fromDate && toDate && fromDate > toDate) { setList([]); setLoadError('DATE_RANGE'); setLoading(false); return; }
    try {
      const data = await getLedger({ type: type || undefined, from: dayStart(fromDate), to: dayStart(toDate) });
      if (sequence !== loadSequence.current) return;
      setList(data);
    }
    catch (error) { if (sequence === loadSequence.current) setLoadError(error instanceof Error ? error.message : 'LOAD_FAILED'); }
    finally { if (sequence === loadSequence.current) setLoading(false); }
  }, [type, fromDate, toDate]);

  useSharedRefresh(load);
  useEffect(() => { load(); }, [load]);
  useEffect(() => () => { loadSequence.current += 1; }, []);

  const totals = useMemo(() => list.reduce((result, entry) => { if (entry.type === 'income' || entry.type === 'receivable') result.in += entry.amount; else result.out += entry.amount; return result; }, { in: 0, out: 0 }), [list]);
  const amountPreview = useMemo(() => previewMoneyInput(amount), [amount]);

  const save = async () => {
    let value: number;
    try { value = parseMoneyInput(amount, '\u91d1\u989d', true); }
    catch (error) { Taro.showToast({ title: error instanceof Error ? error.message : '\u91d1\u989d\u5fc5\u987b\u5927\u4e8e 0', icon: 'none' }); return; }
    if (saving) return;
    setSaving(true);
    try {
      await addLedger({ type: kind, amount: value, remark: remark.trim() });
      setAmount(''); setRemark(''); setShow(false);
      Taro.showToast({ title: '流水保存成功', icon: 'success' });
      await load();
    } catch (error) { Taro.showToast({ title: error?.message || '流水保存失败', icon: 'none' }); }
    finally { setSaving(false); }
  };

  const remove = useCallback(async (entry: LedgerEntry) => {
    const result = await Taro.showModal({ title: '作废流水？', content: '作废后将保留历史记录且不再计入汇总，确定继续吗？', confirmColor: '#dc2626' });
    if (!result.confirm) return;
    try { await deleteLedger(entry.id); Taro.showToast({ title: '流水已作废', icon: 'success' }); await load(); }
    catch (error) { Taro.showToast({ title: error?.message || '流水作废失败', icon: 'none' }); }
  }, [load]);

  const exportCsv = async () => {
    try {
      if (fromDate && toDate && fromDate > toDate) throw new Error('开始日期不能晚于结束日期');
      const params = new URLSearchParams();
      if (type) params.set('type', type);
      if (fromDate) params.set('from', String(dayStart(fromDate)));
      if (toDate) params.set('to', String(dayStart(toDate)));
      await downloadCsv(`/api/export/ledger.csv${params.toString() ? `?${params}` : ''}`, 'warehouse-ledger.csv');
    } catch (error) { Taro.showToast({ title: error?.message || '导出失败', icon: 'none' }); }
  };
  return <ScrollView scrollY className={styles.page} refresherEnabled onRefresherRefresh={load}>
    <View className={styles.summary}><View><Text>收入 / 应收</Text><Text className={styles.in}>{formatMoney(totals.in)}</Text></View><View><Text>支出 / 应付</Text><Text className={styles.out}>{formatMoney(totals.out)}</Text></View></View>
    <View className={styles.filters}><View className={styles.export} onClick={exportCsv}>导出 CSV</View><Picker range={types.map(item => item.label)} onChange={e => setType(types[Number(e.detail.value)].value)}><View className={styles.select}>{types.find(item => item.value === type)?.label}</View></Picker><Picker mode="date" value={fromDate} onChange={e => setFromDate(e.detail.value)}><View className={styles.datePicker}>{fromDate || '开始日期'}</View></Picker><Picker mode="date" value={toDate} onChange={e => setToDate(e.detail.value)}><View className={styles.datePicker}>{toDate || '结束日期'}</View></Picker></View>
    {loading ? <View className={styles.empty}>正在加载流水…</View> : loadError ? <View className={styles.empty} onClick={load}>{loadError === 'DATE_RANGE' ? '开始日期不能晚于结束日期' : loadError === 'LOAD_FAILED' ? '流水加载失败' : loadError} · 点击重试</View> : list.length === 0 ? <View className={styles.empty}>暂无流水</View> : list.map(entry => <LedgerListRow key={entry.id} entry={entry} label={types.find(item => item.value === entry.type)?.label || '未知类型'} onRemove={remove} />)}
    {show && <View className={styles.form}><Picker range={types.slice(1).map(item => item.label)} onChange={e => setKind(types.slice(1)[Number(e.detail.value)].value as LedgerType)}><View className={styles.select}>{types.find(item => item.value === kind)?.label}</View></Picker><Input type="digit" placeholder="金额" value={amount} onInput={e => setAmount(sanitizeNonNegativeMoneyInput(e.detail.value))} /><Text className={styles.remark}>本次金额预览 {amountPreview === null ? '\u2014' : formatMoney(amountPreview)}</Text><Input placeholder="流水说明（建议填写）" value={remark} onInput={e => setRemark(e.detail.value)} /><Button onClick={save} disabled={saving}>{saving ? '保存中…' : '保存流水'}</Button></View>}
    {!show && <Button className={styles.add} onClick={() => setShow(true)}>+ 新增流水</Button>}
  </ScrollView>;
}
