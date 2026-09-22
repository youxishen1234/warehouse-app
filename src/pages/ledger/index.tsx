import { useSharedRefresh } from '@/services/shared-refresh';
import React, { useCallback, useEffect, useMemo, useState } from 'react';
import { View, Text, Input, Picker, Button, ScrollView } from '@tarojs/components';
import Taro from '@tarojs/taro';
import { addLedger, deleteLedger, getLedger, LedgerEntry, LedgerType } from '@/services/api';
import { formatShortTime } from '@/utils/format';
import { getBaseUrl } from '@/services/request';
import { session } from '@/services/session';
import styles from './index.module.scss';

const types: { value: LedgerType | ''; label: string }[] = [{ value: '', label: '全部' }, { value: 'income', label: '收入' }, { value: 'expense', label: '支出' }, { value: 'receivable', label: '应收' }, { value: 'payable', label: '应付' }, { value: 'settlement', label: '结清' }];

const dayStart = (value: string) => value ? new Date(`${value}T00:00:00`).getTime() : undefined;

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

  const load = useCallback(async () => {
    if (fromDate && toDate && fromDate > toDate) { Taro.showToast({ title: '开始日期不能晚于结束日期', icon: 'none' }); setList([]); return; }
    try { setList(await getLedger({ type: type || undefined, from: dayStart(fromDate), to: dayStart(toDate) })); }
    catch (error) { Taro.showToast({ title: error?.message || '流水加载失败', icon: 'none' }); }
  }, [type, fromDate, toDate]);

  useSharedRefresh(load);
  useEffect(() => { load(); }, [load]);

  const totals = useMemo(() => list.reduce((result, entry) => { if (entry.type === 'income' || entry.type === 'receivable') result.in += entry.amount; else result.out += entry.amount; return result; }, { in: 0, out: 0 }), [list]);

  const save = async () => {
    const value = Number(amount);
    if (!Number.isFinite(value) || value <= 0) { Taro.showToast({ title: '金额必须大于 0', icon: 'none' }); return; }
    if (saving) return;
    setSaving(true);
    try { await addLedger({ type: kind, amount: value, remark: remark.trim() }); setAmount(''); setRemark(''); setShow(false); Taro.showToast({ title: '流水保存成功', icon: 'success' }); await load(); }
    catch (error) { Taro.showToast({ title: error?.message || '流水保存失败', icon: 'none' }); }
    finally { setSaving(false); }
  };

  const remove = async (entry: LedgerEntry) => {
    const result = await Taro.showModal({ title: '删除流水？', content: '删除后无法恢复，确定继续吗？', confirmColor: '#dc2626' });
    if (!result.confirm) return;
    try { await deleteLedger(entry.id); Taro.showToast({ title: '删除成功', icon: 'success' }); await load(); }
    catch (error) { Taro.showToast({ title: error?.message || '删除失败', icon: 'none' }); }
  };

  const exportCsv = async () => {
    try {
      const token = session()?.token;
      const params = new URLSearchParams();
      if (type) params.set('type', type);
      if (fromDate) params.set('from', String(dayStart(fromDate)));
      if (toDate) params.set('to', String(dayStart(toDate)));
      const result = await Taro.downloadFile({ url: `${getBaseUrl()}/api/export/ledger.csv${params.toString() ? `?${params}` : ''}`, header: token ? { Authorization: `Bearer ${token}` } : {} });
      if (result.statusCode !== 200) throw new Error('导出失败');
      Taro.showToast({ title: 'CSV 已生成', icon: 'success' });
    } catch (error) { Taro.showToast({ title: error?.message || '导出失败', icon: 'none' }); }
  };

  return <ScrollView scrollY className={styles.page} refresherEnabled onRefresherRefresh={load}>
    <View className={styles.summary}><View><Text>收入 / 应收</Text><Text className={styles.in}>¥{totals.in.toFixed(2)}</Text></View><View><Text>支出 / 应付</Text><Text className={styles.out}>¥{totals.out.toFixed(2)}</Text></View></View>
    <View className={styles.filters}><View className={styles.export} onClick={exportCsv}>导出 CSV</View><Picker range={types.map(item => item.label)} onChange={e => setType(types[Number(e.detail.value)].value)}><View className={styles.select}>{types.find(item => item.value === type)?.label}</View></Picker><Picker mode="date" value={fromDate || undefined} onChange={e => setFromDate(e.detail.value)}><View className={styles.datePicker}>{fromDate || '开始日期'}</View></Picker><Picker mode="date" value={toDate || undefined} onChange={e => setToDate(e.detail.value)}><View className={styles.datePicker}>{toDate || '结束日期'}</View></Picker></View>
    {list.length === 0 ? <View className={styles.empty}>暂无账本流水</View> : list.map(entry => <View className={styles.item} key={entry.id}><View><Text className={styles.itemTitle}>{types.find(item => item.value === entry.type)?.label} · {entry.party_name || '未关联对象'}</Text><Text className={styles.remark}>{entry.remark || '无说明'} · {formatShortTime(entry.created_at)}</Text></View><Text className={entry.type === 'income' || entry.type === 'receivable' ? styles.in : styles.out}>{entry.type === 'income' || entry.type === 'receivable' ? '+' : '-'}¥{Number(entry.amount).toFixed(2)}</Text><Text className={styles.delete} onClick={() => remove(entry)}>删除</Text></View>)}
    {show && <View className={styles.form}><Picker range={types.slice(1).map(item => item.label)} onChange={e => setKind(types.slice(1)[Number(e.detail.value)].value as LedgerType)}><View className={styles.select}>{types.find(item => item.value === kind)?.label}</View></Picker><Input type="digit" placeholder="金额" value={amount} onInput={e => setAmount(e.detail.value)} /><Input placeholder="流水说明（建议填写）" value={remark} onInput={e => setRemark(e.detail.value)} /><Button onClick={save} disabled={saving}>{saving ? '保存中…' : '保存流水'}</Button></View>}
    {!show && <Button className={styles.add} onClick={() => setShow(true)}>+ 新增流水</Button>}
  </ScrollView>;
}
