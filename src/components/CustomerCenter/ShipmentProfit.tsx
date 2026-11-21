/* eslint-disable react/forbid-elements */
import { useCallback, useState } from 'react';
import { DemoDetail, DemoField } from '@/components/DemoUI';
import { useRemoteData } from '@/hooks/useRemoteData';
import { request } from '@/services/request';
import { formatMoney, formatShortTime } from '@/utils/format';

type Totals = { cents: number; confirmed: number; pending: number };
type ProfitRow = {
  id: number; name: string; specification: string; quantity: number; unit: string; created_at: number;
  sales: number | null; cost: number | null; profit: number | null; batch_id: string | null;
  candidates: { id: string; quantity: number; created_at: number }[];
};
type Report = { summary: Totals; customers: Record<string, Totals>; items: ProfitRow[]; total: number; pageSize: number };
const empty: Report = { summary: { cents: 0, confirmed: 0, pending: 0 }, customers: {}, items: [], total: 0, pageSize: 20 };
const amount = (value: number | null, unknown = '待确认') => value === null ? unknown : formatMoney(value);

export function useCustomerProfit(from: number, customerId?: number, page = 1) {
  const load = useCallback(() => request<Report>({
    url: `/api/customer-profit?from=${from}&page=${page}${customerId ? `&customer_id=${customerId}` : ''}`
  }), [customerId, from, page]);
  return useRemoteData(load, empty);
}

export function ProfitSummary({ label, totals }: { label: string; totals: Totals }) {
  return <div className='demo-card' aria-live='polite'>
    <DemoDetail label={label}>{totals.confirmed ? formatMoney(totals.cents / 100) : '—'}</DemoDetail>
    <div className='demo-meta'>仅扣纸板成本 · {totals.confirmed} 笔已计算 · {totals.pending} 笔待确认</div>
  </div>;
}

export function ProfitPeriod({ from, month, onChange }: { from: number; month: number; onChange: (from: number) => void }) {
  return <DemoField label='统计期间'><select aria-label='统计期间' value={from} onChange={event => onChange(Number(event.target.value))}>
    <option value={month}>本月</option><option value={0}>全部时间</option>
  </select></DemoField>;
}

export default function ShipmentProfit({ customerId, from, canEdit, onSaved }: {
  customerId: number; from: number; canEdit: boolean; onSaved: () => Promise<void>;
}) {
  const [page, setPage] = useState(1);
  const [selectedId, setSelectedId] = useState<number | null>(null);
  const [batchId, setBatchId] = useState('');
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState('');
  const { data, loading, loadError, reload } = useCustomerProfit(from, customerId, page);
  const select = (row?: ProfitRow) => {
    setSelectedId(row?.id ?? null); setBatchId(row?.batch_id ?? ''); setError('');
  };
  const save = async (row: ProfitRow) => {
    setSaving(true); setError('');
    try {
      await request({ url: `/api/transactions/${row.id}/profit-batch`, method: 'PUT', data: { batch_id: batchId || null } });
      await Promise.all([reload(), onSaved()]);
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : '保存失败，请重试');
    } finally { setSaving(false); }
  };
  const move = (next: number) => { select(); setPage(next); };
  if (loading) return <p role='status'>正在读取利润…</p>;
  if (loadError) return <div role='alert' className='demo-error'>{loadError}<button type='button' className='demo-action' onClick={() => void reload()}>重新读取</button></div>;
  return <section aria-label='利润' data-testid='customer-shipment-profit'>
    <ProfitSummary label='客户总利润' totals={data.summary} />
    {!data.total && <p>该期间暂无出库记录</p>}
    {data.items.map(row => <article className='demo-card' key={row.id}>
      <button type='button' className='demo-action' aria-expanded={selectedId === row.id} disabled={saving}
        onClick={() => select(selectedId === row.id ? undefined : row)}>
        {row.name || row.specification || '货物'} · {row.quantity} {row.unit} · {amount(row.profit, '待确认')}
      </button>
      <div className='demo-meta'>出库 #{row.id} · {formatShortTime(row.created_at)}</div>
      {selectedId === row.id && <>
        <DemoDetail label='销售额'>{amount(row.sales, '未记录')}</DemoDetail>
        <DemoDetail label='纸板成本'>{amount(row.cost)}</DemoDetail>
        <DemoDetail label='利润'>{amount(row.profit, '未计入总利润')}</DemoDetail>
        {row.batch_id && <DemoDetail label='已确认完工批次'>{row.batch_id}</DemoDetail>}
        {canEdit && (row.candidates.length > 0 || row.batch_id) && <>
          <DemoField label='完工批次'><select aria-label='完工批次' value={batchId} disabled={saving} onChange={event => setBatchId(event.target.value)}>
            <option value=''>{row.batch_id ? '取消批次确认' : '请选择完工批次'}</option>
            {row.candidates.map(batch => <option key={batch.id} value={batch.id}>{formatShortTime(batch.created_at)} · {batch.id} · 完工 {batch.quantity} {row.unit}</option>)}
          </select></DemoField>
          <button type='button' className='demo-action' disabled={saving || batchId === (row.batch_id ?? '')} onClick={() => void save(row)}>保存批次</button>
        </>}
        {!row.batch_id && row.candidates.length === 0 && <p>没有足量的单个完工批次，暂不计入利润</p>}
        {error && <div role='alert' className='demo-error'>{error}</div>}
      </>}
    </article>)}
    {(page > 1 || page * data.pageSize < data.total) && <div className='demo-row'>
      <button type='button' className='demo-action' disabled={saving || page <= 1} onClick={() => move(page - 1)}>上一页</button>
      <button type='button' className='demo-action' disabled={saving || page * data.pageSize >= data.total} onClick={() => move(page + 1)}>下一页</button>
    </div>}
  </section>;
}
