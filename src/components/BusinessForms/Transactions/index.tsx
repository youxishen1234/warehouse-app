/* eslint-disable react/forbid-elements */
import { useSharedRefresh } from '@/services/shared-refresh';
import React, { useState, useCallback, useMemo, useRef } from 'react';
import { DemoPage, DemoSheet, DemoField, DemoDetail } from '@/components/DemoUI';
import Taro, { useRouter } from '@tarojs/taro';
import { deleteTransaction, getCustomers, getSuppliers, getTransactions, updateTransaction } from '@/services/api';
import { loadProducts } from '@/services/product-store';
import { downloadCsv } from '@/services/download';
import { getCopy } from '@/services/copy';
import { formatMoney, formatShortTime } from '@/utils/format';
import type { Transaction, Product, Customer, Supplier } from '@/types';
import { useRemoteData } from '@/hooks/useRemoteData';

type RecordListRowProps = {
  transaction: Transaction;
  productLabel: string;
  onEdit: (transaction: Transaction) => void;
  onDelete: (transaction: Transaction) => void;
};

// Transaction rows are read-only. Memoizing one row prevents filter/export
// controls and product lookups from re-rendering every unchanged record.
const RecordListRow = React.memo(function RecordListRow({ transaction: t, productLabel, onEdit, onDelete }: RecordListRowProps) {
  const editable = !t.voided_at && (t.type === 'in' || t.type === 'out') && !t.delivery_note_id && !t.production_id && !t.order_id;
  return <article className='demo-card'><div className='demo-row'><h3>{productLabel}</h3><span className='demo-badge'>{t.voided_at ? '已作废' : t.type === 'in' ? '入库' : t.type === 'out' ? '出库' : '盘点'}</span></div>
    <p>{t.customer_name || t.supplier_name}{(t.customer_current_name || t.supplier_current_name) && ` · ${getCopy('currentPartyName')}：${t.customer_current_name || t.supplier_current_name}`}</p>
    <div className='demo-goods'><span>{[t.specification, t.material].filter(Boolean).join(' · ')}</span><strong>{t.type === 'out' ? '−' : '+'}{t.type === 'adjustment' ? t.adjustment ?? t.quantity : t.quantity} {t.unit}</strong></div>
    <DemoDetail label='单价 / 金额'>{formatMoney(t.unit_price || 0)} / {formatMoney(t.amount || 0)}</DemoDetail>
    <div className='demo-card-foot'><span>{formatShortTime(t.created_at)}</span>{editable && <div className='demo-row'><button type='button' className='demo-action' onClick={() => onEdit(t)}>编辑</button><button type='button' className='demo-action' onClick={() => onDelete(t)}>删除</button></div>}</div>
    {(t.operator || t.remark) && <p>{[t.operator, t.remark].filter(Boolean).join(' · ')}</p>}
  </article>;
});

const RecordsPage: React.FC = () => {
  const router = useRouter();
  // 从客户管理页跳转时携带客户筛选
  const filterCustomerId = router.params.customer_id ? Number(router.params.customer_id) : null;
  const filterSupplierId = router.params.supplier_id ? Number(router.params.supplier_id) : null;
  const filterProductId = router.params.product_id ? Number(router.params.product_id) : null;
  const filterCustomerName = router.params.customer_name ? decodeURIComponent(router.params.customer_name) : '';

  const [type, setType] = useState(() => ['in', 'out'].includes(router.params.type || '') ? router.params.type! : '');
  const [typeIndex, setTypeIndex] = useState(() => router.params.type === 'in' ? 1 : router.params.type === 'out' ? 2 : 0);
  const [fromDate, setFromDate] = useState('');
  const [toDate, setToDate] = useState('');
  const [includeVoided, setIncludeVoided] = useState(false);
  const [editing, setEditing] = useState<Transaction | null>(null);
  const [editBusy, setEditBusy] = useState(false);
  const [parties, setParties] = useState<Array<Customer | Supplier>>([]);
  const [draft, setDraft] = useState({ productIndex: 0, quantity: '', unitPrice: '', partyIndex: 0, remark: '' });
  const lastLoadAt = useRef(0);
  const inFlight = useRef<Promise<{ list: Transaction[]; products: Product[] }> | null>(null);

  const types = ['全部', '入库', '出库'];

  const loadRecords = useCallback(async () => {
    const startedAt = Date.now();
    // 短时间内的重复刷新复用进行中的请求：空数据不是“跳过刷新”的合法结果，
    // 否则真实请求的结果会被较新的空结果覆盖，页面误显示“暂无记录”。
    if (startedAt - lastLoadAt.current < 250 && inFlight.current) return inFlight.current;
    lastLoadAt.current = startedAt;
    if (fromDate && toDate && fromDate > toDate) {
      Taro.showToast({ title: '开始日期不能晚于结束日期', icon: 'none' });
      throw new Error(getCopy('recordsInvalidDates'));
    }
    const run = (async () => {
      try {
        const [tx, prods] = await Promise.all([
          getTransactions({
            type: type || undefined,
            include_voided: includeVoided,
            customer_id: filterCustomerId || undefined,
            supplier_id: filterSupplierId || undefined
            , from: fromDate ? new Date(`${fromDate}T00:00:00`).getTime() : undefined
            , to: toDate ? new Date(`${toDate}T00:00:00`).getTime() : undefined
          }), loadProducts()]);
        return { list: filterProductId ? tx.filter(row => row.product_id === filterProductId) : tx, products: prods };
      } catch (_error) {
        // Keep the records page error surface Chinese and actionable even when
        // a proxy or mocked API returns an internal English/path-bearing error.
        throw new Error(getCopy('recordsLoadFailed'));
      }
    })();
    inFlight.current = run;
    try { return await run; } finally { if (inFlight.current === run) inFlight.current = null; }
  }, [type, filterCustomerId, filterSupplierId, filterProductId, fromDate, toDate, includeVoided]);

  const remote = useRemoteData(loadRecords, { list: [] as Transaction[], products: [] as Product[] });
  // useRemoteData owns the loadSequence/requestId stale-response guard: if (current !== loadSequence.current), it discards the response and invalidates on unload.
  const list = remote.data.list;
  const products = remote.data.products;
  const loading = remote.loading;
  const loadError = remote.loadError;
  const load = remote.reload;

  useSharedRefresh(load);

  const productNames = useMemo(() => new Map(products.map(product => [product.id, product.name])), [products]);
  const openEditor = useCallback(async (transaction: Transaction) => {
    if (transaction.type !== 'in' && transaction.type !== 'out') {
      Taro.showToast({ title: '盘点记录请在库存页修改', icon: 'none' });
      return;
    }
    setEditing(transaction);
    setParties([]);
    setDraft({
      productIndex: Math.max(0, products.findIndex(product => product.id === transaction.product_id)),
      quantity: String(transaction.quantity ?? ''),
      unitPrice: String(transaction.unit_price ?? ''),
      partyIndex: 0,
      remark: transaction.remark || ''
    });
    try {
      const partyList = transaction.type === 'in' ? await getSuppliers() : await getCustomers();
      setParties(partyList);
      const currentId = transaction.type === 'in' ? transaction.supplier_id : transaction.customer_id;
      const index = partyList.findIndex(party => party.id === currentId);
      setDraft(previous => ({ ...previous, partyIndex: index >= 0 ? index + 1 : 0 }));
    } catch (_error) {
      Taro.showToast({ title: '往来单位加载失败，可先修改数量或单价', icon: 'none' });
    }
  }, [products]);

  const saveEdit = useCallback(async () => {
    if (!editing || editBusy) return;
    const quantity = Number(draft.quantity);
    const unitPrice = Number(draft.unitPrice);
    if (!Number.isFinite(quantity) || quantity <= 0) {
      Taro.showToast({ title: '数量必须大于零', icon: 'none' });
      return;
    }
    if (!Number.isFinite(unitPrice) || unitPrice < 0) {
      Taro.showToast({ title: '单价必须是非负数字', icon: 'none' });
      return;
    }
    const product = products[draft.productIndex];
    const party = draft.partyIndex > 0 ? parties[draft.partyIndex - 1] : null;
    setEditBusy(true);
    try {
      await updateTransaction(editing.id, {
        product_id: product?.id ?? editing.product_id,
        quantity,
        unit_price: unitPrice,
        ...(editing.type === 'in' ? { supplier_id: party?.id ?? null } : { customer_id: party?.id ?? null }),
        remark: draft.remark.trim()
      });
      Taro.showToast({ title: '已保存', icon: 'success' });
      setEditing(null);
      load();
    } catch (error) {
      Taro.showToast({ title: error?.message || '保存失败', icon: 'none' });
    } finally {
      setEditBusy(false);
    }
  }, [draft, editBusy, editing, load, parties, products]);

  const removeRecord = useCallback(async (transaction: Transaction) => {
    const result = await Taro.showModal({
      title: '删除这条记录？',
      content: '库存和往来金额会同步回退，记录保留作废标记，可在“显示作废历史”中查看。'
    });
    if (!result.confirm) return;
    try {
      await deleteTransaction(transaction.id);
      Taro.showToast({ title: '已删除', icon: 'success' });
      load();
    } catch (error) {
      Taro.showToast({ title: error?.message || '删除失败', icon: 'none' });
    }
  }, [load]);

  const exportCsv = async () => {
    try {
      if (fromDate && toDate && fromDate > toDate) throw new Error('开始日期不能晚于结束日期');
      const filters = { type, customer_id: filterCustomerId, supplier_id: filterSupplierId, include_voided: includeVoided, from: fromDate ? new Date(`${fromDate}T00:00:00`).getTime() : '', to: toDate ? new Date(`${toDate}T00:00:00`).getTime() : '' };
      const query = Object.entries(filters).filter(([, value]) => value !== '' && value !== null).map(([key, value]) => `${key}=${encodeURIComponent(String(value))}`).join('&');
      await downloadCsv(`/api/export/transactions.csv?${query}`, 'stock-records.csv');
    } catch (error) { Taro.showToast({ title: error?.message || '导出失败', icon: 'none' }); }
  };

  return <DemoPage title='出入库单据' action={<button type='button' className='demo-action' onClick={() => void exportCsv()}>导出 CSV</button>}>
    <div className='demo-pills'>{types.map((label, index) => <button type='button' key={label} aria-pressed={typeIndex === index} onClick={() => { setTypeIndex(index); setType(index === 0 ? '' : index === 1 ? 'in' : 'out'); }}>{label}</button>)}</div>
    <div className='demo-two'><DemoField label='开始日期'><input type='date' aria-label='开始日期' value={fromDate} onChange={event => setFromDate(event.target.value)} /></DemoField><DemoField label='结束日期'><input type='date' aria-label='结束日期' value={toDate} onChange={event => setToDate(event.target.value)} /></DemoField></div>
    <label className='demo-check'><input type='checkbox' checked={includeVoided} onChange={event => setIncludeVoided(event.target.checked)} />显示作废历史</label>
    {(filterCustomerId || filterSupplierId) && <div className='demo-note'>{filterSupplierId ? '当前供应商' : '当前客户'}：{filterCustomerName || `#${filterSupplierId || filterCustomerId}`}<button type='button' className='demo-action' onClick={() => void Taro.redirectTo({ url: '/pages/management/index?section=transactions' })}>清除筛选</button></div>}
    {loading ? <div className='demo-empty'>{getCopy('recordsLoading')}</div> : loadError ? <div className='demo-error' role='alert'>{loadError}<button type='button' className='demo-action' onClick={() => void load()}>重新读取</button></div> : !list.length ? <div className='demo-empty'>暂无记录</div> : list.map(transaction => <RecordListRow key={transaction.id} transaction={transaction} productLabel={transaction.product_name || productNames.get(transaction.product_id) || '货物未记录'} onEdit={openEditor} onDelete={removeRecord} />)}
    {editing && <DemoSheet title={`编辑${editing.type === 'in' ? '入库' : '出库'}记录`} busy={editBusy} onClose={() => setEditing(null)}>
      <DemoField label='商品'><select aria-label='商品' value={draft.productIndex} disabled={editBusy} onChange={event => setDraft(previous => ({ ...previous, productIndex: Number(event.target.value) }))}>{products.map((product, index) => <option value={index} key={product.id}>{product.name}</option>)}</select></DemoField>
      <div className='demo-two'><DemoField label='数量'><input type='number' aria-label='数量' value={draft.quantity} disabled={editBusy} onChange={event => setDraft(previous => ({ ...previous, quantity: event.target.value }))} /></DemoField><DemoField label='单价'><input type='number' aria-label='单价' value={draft.unitPrice} disabled={editBusy} onChange={event => setDraft(previous => ({ ...previous, unitPrice: event.target.value }))} /></DemoField></div>
      <DemoField label={editing.type === 'in' ? '供应商' : '客户'}><select aria-label='关联对象' value={draft.partyIndex} disabled={editBusy} onChange={event => setDraft(previous => ({ ...previous, partyIndex: Number(event.target.value) }))}><option value={0}>不关联</option>{parties.map((party, index) => <option value={index + 1} key={party.id}>{party.name}</option>)}</select></DemoField>
      <DemoField label='备注'><input aria-label='备注' value={draft.remark} disabled={editBusy} onChange={event => setDraft(previous => ({ ...previous, remark: event.target.value }))} /></DemoField>
      <button type='button' className='demo-primary' disabled={editBusy} onClick={() => void saveEdit()}>{editBusy ? '保存中…' : '保存修改'}</button>
    </DemoSheet>}
  </DemoPage>;
};

export default RecordsPage;
