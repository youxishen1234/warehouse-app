import { useSharedRefresh } from '@/services/shared-refresh';
import React, { useState, useCallback, useMemo, useRef } from 'react';
import { View, Text, ScrollView, Picker, Switch, Input } from '@tarojs/components';
import Taro, { useRouter } from '@tarojs/taro';
import { deleteTransaction, getCustomers, getSuppliers, getTransactions, updateTransaction } from '@/services/api';
import { loadProducts } from '@/services/product-store';
import { downloadCsv } from '@/services/download';
import { getCopy } from '@/services/copy';
import { formatMoney, formatShortTime } from '@/utils/format';
import type { Transaction, Product, Customer, Supplier } from '@/types';
import styles from './index.module.scss';
import { useRemoteData } from '@/hooks/useRemoteData';
import BusinessHeader from '@/components/BusinessHeader';

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
  return (
    <View className={styles.listItem}>
      <View className={styles.itemTop}>
        <View className={styles.titleWrap}>
          <Text className={styles.itemName}>{productLabel}</Text>
          {!!t.voided_at && <Text className={styles.tagOut}>已作废 · 不计库存及金额</Text>}
          {(t.customer_name || t.supplier_name) && (
            <Text className={styles.customerName}>
              {t.customer_name || t.supplier_name}
              {(t.customer_name ? t.customer_current_name && t.customer_current_name !== t.customer_name : t.supplier_current_name && t.supplier_current_name !== t.supplier_name)
                ? `（${getCopy('currentPartyName')}：${t.customer_name ? t.customer_current_name : t.supplier_current_name}）` : ''}
            </Text>
          )}
        </View>
        {t.type === 'in'
          ? <Text className={styles.tagIn}>入库</Text>
          : t.type === 'adjustment' ? <Text className={styles.tagIn}>盘点</Text> : <Text className={styles.tagOut}>出库</Text>}
      </View>

      <View className={styles.metaBlock}>
        <Text className={styles.itemTime}>{formatShortTime(t.created_at)}</Text>
        <Text className={styles.itemRemark}>
          {t.operator || t.remark
            ? `${t.operator ? `操作人：${t.operator}` : ''}${t.operator && t.remark ? ' · ' : ''}${t.remark ? `备注：${t.remark}` : ''}`
            : '暂无备注'}
        </Text>
        <Text className={styles.itemRemark}>规格：{t.specification || '无'} · 材质：{t.material || '无'} · {t.unit || ''} · 单价 {formatMoney(t.unit_price || 0)} · 金额 {formatMoney(t.amount || 0)}</Text>
      </View>

      <View className={styles.itemBottom}>
        <Text className={styles.itemQtyLabel}>数量</Text>
        <View className={styles.itemBottomRight}>
          <Text className={styles.itemQty} style={{ color: t.type === 'out' ? '#dc2626' : '#16a34a' }}>
            {t.type === 'adjustment' ? `${Number(t.adjustment) >= 0 ? '+' : ''}${t.adjustment ?? t.quantity}` : `${t.type === 'out' ? '-' : '+'}${t.quantity}`}{t.unit}
          </Text>
          {editable && (
            <View className={styles.rowActions}>
              <Text className={styles.rowEdit} onClick={() => onEdit(t)}>编辑</Text>
              <Text className={styles.rowDelete} onClick={() => onDelete(t)}>删除</Text>
            </View>
          )}
        </View>
      </View>
    </View>
  );
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

  return (
    <View className={styles.page}>
    <ScrollView scrollY className={styles.container} onRefresherRefresh={load} refresherEnabled refresherTriggered={false}>
      <BusinessHeader title='出入库单据' />
      <View className={styles.filterBox}>
        <View className={styles.exportBtn} onClick={exportCsv}>导出 CSV</View>
        <Picker mode="selector" range={types} value={typeIndex} onChange={e => {
          const idx = Number(e.detail.value);
          setTypeIndex(idx);
          setType(idx === 0 ? '' : idx === 1 ? 'in' : 'out');
        }}>
          <View className={styles.filterSelect}>{types[typeIndex]}</View>
        </Picker>
        <Picker mode="date" value={fromDate} onChange={e=>setFromDate(e.detail.value)}><View className={styles.datePicker}>{fromDate || '开始日期'}</View></Picker>
        <Picker mode="date" value={toDate} onChange={e=>setToDate(e.detail.value)}><View className={styles.datePicker}>{toDate || '结束日期'}</View></Picker>
        <View><Text>显示作废历史</Text><Switch checked={includeVoided} onChange={e => setIncludeVoided(e.detail.value)} /></View>
      </View>

      {(filterCustomerId || filterSupplierId) && (
        <View className={styles.customerFilterBar}>
          <Text className={styles.customerFilterText}>{filterSupplierId ? '当前供应商' : '当前客户'}：{filterCustomerName || `#${filterSupplierId || filterCustomerId}`}</Text>
          <Text
            className={styles.customerFilterClear}
            onClick={() => Taro.redirectTo({ url: '/pages/records/index' })}
          >
            清除筛选 ✕
          </Text>
        </View>
      )}

      {loading ? (
        <View className={styles.empty}>{getCopy('recordsLoading')}</View>
      ) : loadError ? (
        <View className={styles.empty} onClick={load}>{loadError}</View>
      ) : list.length === 0 ? (
        <View className={styles.empty}>暂无记录</View>
      ) : (
        list.map(transaction => <RecordListRow
          key={transaction.id}
          transaction={transaction}
          productLabel={transaction.product_name || productNames.get(transaction.product_id) || '(?????)'}
          onEdit={openEditor}
          onDelete={removeRecord}
        />)
      )}
    </ScrollView>
    {editing && (
      <View className={styles.sheetMask} onClick={() => { if (!editBusy) setEditing(null); }}>
        <View className={styles.sheet} role='dialog' aria-modal='true' aria-label='编辑出入库记录' onClick={e => e.stopPropagation()}>
          <Text className={styles.sheetTitle}>编辑{editing.type === 'in' ? '入库' : '出库'}记录</Text>
          <View className={styles.fieldRow}>
            <Text className={styles.fieldLabel}>商品</Text>
            {products.length > 0 ? (
              <Picker mode='selector' range={products.map(product => product.name)} value={draft.productIndex}
                onChange={e => setDraft(previous => ({ ...previous, productIndex: Number(e.detail.value) }))}>
                <View className={styles.sheetPicker}>{products[draft.productIndex]?.name || '请选择商品'}</View>
              </Picker>
            ) : <Text className={styles.staticValue}>{editing.product_name || '原商品'}</Text>}
          </View>
          <View className={styles.fieldRow}>
            <Text className={styles.fieldLabel}>数量</Text>
            <Input className={styles.sheetInput} type='digit' value={draft.quantity}
              onInput={e => setDraft(previous => ({ ...previous, quantity: e.detail.value }))} placeholder='必填' />
          </View>
          <View className={styles.fieldRow}>
            <Text className={styles.fieldLabel}>单价</Text>
            <Input className={styles.sheetInput} type='digit' value={draft.unitPrice}
              onInput={e => setDraft(previous => ({ ...previous, unitPrice: e.detail.value }))} placeholder='0' />
          </View>
          <View className={styles.fieldRow}>
            <Text className={styles.fieldLabel}>{editing.type === 'in' ? '供应商' : '客户'}</Text>
            <Picker mode='selector' range={['不关联', ...parties.map(party => party.name)]} value={draft.partyIndex}
              onChange={e => setDraft(previous => ({ ...previous, partyIndex: Number(e.detail.value) }))}>
              <View className={styles.sheetPicker}>{draft.partyIndex === 0 ? '不关联' : parties[draft.partyIndex - 1]?.name || '请选择'}</View>
            </Picker>
          </View>
          <View className={styles.fieldRow}>
            <Text className={styles.fieldLabel}>备注</Text>
            <Input className={styles.sheetInput} value={draft.remark}
              onInput={e => setDraft(previous => ({ ...previous, remark: e.detail.value }))} placeholder='选填' />
          </View>
          <View className={styles.sheetActions}>
            <View className={styles.cancelBtn} onClick={() => { if (!editBusy) setEditing(null); }}>取消</View>
            <View className={`${styles.saveBtn} ${editBusy ? styles.saveBtnBusy : ''}`} onClick={saveEdit}>
              {editBusy ? '保存中…' : '保存修改'}
            </View>
          </View>
        </View>
      </View>
    )}
    </View>
  );
};

export default RecordsPage;
