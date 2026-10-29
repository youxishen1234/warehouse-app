/* eslint-disable react/forbid-elements */
import { useCallback, useEffect, useMemo, useState } from 'react';
import { getCustomers, getSuppliers, getLedger } from '@/services/api';
import { useSharedRefresh } from '@/services/shared-refresh';
import { filterPartyLedgerEntries } from '@/components/FinanceCenter/model';
import Statement from '@/components/FinanceCenter/statement';
import { formatMoney, formatTime } from '@/utils/format';
import type { Customer, Supplier, LedgerEntry } from '@/types';
import styles from './index.module.scss';

export default function PrintStatement() {
  const [customers, setCustomers] = useState<Customer[]>([]);
  const [suppliers, setSuppliers] = useState<Supplier[]>([]);
  const [ledger, setLedger] = useState<LedgerEntry[]>([]);
  const [kind, setKind] = useState<'customer' | 'supplier'>('customer');
  const [id, setId] = useState('');
  const [from, setFrom] = useState('');
  const [to, setTo] = useState('');
  const [error, setError] = useState('');
  const [loading, setLoading] = useState(true);
  const [expanded, setExpanded] = useState(false);
  const reload = useCallback(async () => {
    setLoading(true); setError('');
    try {
      const [nextCustomers, nextSuppliers, nextLedger] = await Promise.all([getCustomers(), getSuppliers(), getLedger()]);
      setCustomers(nextCustomers); setSuppliers(nextSuppliers); setLedger(nextLedger);
    } catch (failure) { setError(failure instanceof Error ? failure.message : '读取往来资料失败'); }
    finally { setLoading(false); }
  }, []);
  useEffect(() => { void reload(); }, [reload]);
  useSharedRefresh(reload);
  const parties = kind === 'customer' ? customers : suppliers;
  const party = parties.find(item => String(item.id) === id && !item.deleted_at);
  const entries = useMemo(() => party ? filterPartyLedgerEntries(ledger, kind, party.id, from, to).slice().sort((a, b) => a.created_at - b.created_at) : [], [party, ledger, kind, from, to]);
  const balance = party ? Number(kind === 'customer' ? (party as Customer).debt : (party as Supplier).payable) || 0 : 0;
  const data = party ? { name: party.name, type: kind, from, to, balance, entries } : undefined;
  return <>
    <section className={styles.demoSource}>
      <div className={styles.sectionHeading}><h2>选择往来单位</h2><span>{loading ? '正在同步…' : '原始账款记录'}</span></div>
      <div className={styles.statementKinds}>
        <button type='button' aria-pressed={kind === 'customer'} onClick={() => { setKind('customer'); setId(''); }}>客户对账单</button>
        <button type='button' aria-pressed={kind === 'supplier'} onClick={() => { setKind('supplier'); setId(''); }}>供货商对账单</button>
      </div>
      <select aria-label='选择对账单位' value={id} onChange={event => setId(event.target.value)}>
        <option value=''>选择{kind === 'customer' ? '客户' : '供货商'}</option>
        {parties.filter(item => !item.deleted_at).map(item => <option key={item.id} value={item.id}>{item.name}</option>)}
      </select>
      <div className={styles.statementDates}><label>开始日期<input type='date' aria-label='对账开始日期' value={from} max={to || undefined} onChange={event => setFrom(event.target.value)} /></label><label>结束日期<input type='date' aria-label='对账结束日期' value={to} min={from || undefined} onChange={event => setTo(event.target.value)} /></label></div>
      {error && <div role='alert' className={styles.error}>{error}<button type='button' onClick={() => void reload()}>重新读取</button></div>}
    </section>
    <div className={styles.demoPaperTools}><span>对账单预览</span><span>A4 纸张</span></div>
    <section className={`${styles.demoPaper} ${styles.statementPaper}`}>
      {party ? <><h2>{kind === 'customer' ? '客户' : '供货商'}对账单</h2><p>{party.name}</p><p>{from || '起始'} 至 {to || '现在'}</p><table><thead><tr><th>业务日期</th><th>往来金额</th></tr></thead><tbody>{entries.map(entry => <tr key={entry.id}><td>{formatTime(entry.created_at)}</td><td>{formatMoney(entry.amount)}</td></tr>)}</tbody></table>{!entries.length && <p>该账期暂无往来流水</p>}<p>当前未结余额 {formatMoney(balance)}</p></> : <div className={styles.demoPaperEmpty}>请选择往来单位</div>}
    </section>
    <div className={styles.demoPrintActions}><button type='button' className={styles.secondary} disabled={!data} onClick={() => setExpanded(true)}>查看大图</button><button type='button' className={styles.primary} disabled={!data} onClick={() => setExpanded(true)}>系统打印 / PDF</button></div>
    {expanded && data && <Statement data={data} onClose={() => setExpanded(false)} />}
  </>;
}
