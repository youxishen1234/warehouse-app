import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { View, Text, Input, ScrollView, Picker } from '@tarojs/components';
import Taro, { useDidShow } from '@tarojs/taro';
import { stockOutBatch, getTransactions, getCustomers, deleteTransaction } from '@/services/api';
import { invalidateProducts, loadProducts } from '@/services/product-store';
import { useSharedRefresh } from '@/services/shared-refresh';
import { formatMoney, formatMoneyPreview, formatShortTime } from '@/utils/format';
import { numberValue, previewAmount, roundDecimal, sanitizeDecimalInput } from '@/utils/stock-math';
import StockProductPicker from '@/components/StockProductPicker';
import type { Product, Transaction, Customer } from '@/types';
import styles from './index.module.scss';
import { useRemoteData } from '@/hooks/useRemoteData';

type EditableLine = { key: string; product_id: number | null; quantity: string; unit_price: string };
const newLine = (): EditableLine => ({ key: `${Date.now()}-${Math.random()}`, product_id: null, quantity: '1', unit_price: '0' });
const applyProduct = (line: EditableLine, product: Product): EditableLine => ({ ...line, product_id: product.id, unit_price: String(product.price) });
const message = (error: unknown) => error instanceof Error ? error.message : '操作失败，请重试';

type RecentOutboundRowProps = { transaction: Transaction; onVoid: (transaction: Transaction) => void };

const RecentOutboundRow = React.memo(function RecentOutboundRow({ transaction, onVoid }: RecentOutboundRowProps) {
  return <View className={styles.recentItem}>
    <View className={styles.recentLeft}>
      <Text className={styles.recentName}>{transaction.product_name || '(?????)'} ? -{transaction.quantity}{transaction.unit}</Text>
      <Text className={styles.recentTime}>{formatShortTime(transaction.created_at)} ? {formatMoney(Number(transaction.amount || 0))}</Text>
      {transaction.customer_name && <Text className={styles.recentCustomer}>{transaction.customer_name}</Text>}
    </View>
    <Text className={styles.deleteBtn} onClick={() => onVoid(transaction)}>??</Text>
  </View>;
});

export default function OutboundPage() {
  const [products, setProducts] = useState<Product[]>([]);
  const [customers, setCustomers] = useState<Customer[]>([]);
  const [customerId, setCustomerId] = useState<number | null>(null);
  const [lines, setLines] = useState<EditableLine[]>([newLine()]);
  const [operator, setOperator] = useState('');
  const [remark, setRemark] = useState('');
  const [recent, setRecent] = useState<Transaction[]>([]);
  const [submitting, setSubmitting] = useState(false);
  const [ready, setReady] = useState(false);
  const [loadError, setLoadError] = useState('');
  const [transitId, setTransitId] = useState<number | null>(null);
  const busy = useRef(false);
  const lastLoadAt = useRef(0);
  const didShowOnce = useRef(false);
  const productMap = useMemo(() => new Map(products.map(product => [product.id, product])), [products]);
  const loadOutboundData = useCallback(async () => {
    lastLoadAt.current = Date.now();
    const [p, c, r] = await Promise.all([loadProducts(true), getCustomers(), getTransactions({ type: 'out' })]);
    return { products: p, customers: c, recent: r.slice(0, 8) };
  }, []);
  const remote = useRemoteData(loadOutboundData, { products: [] as Product[], customers: [] as Customer[], recent: [] as Transaction[] });
  const { reload: remoteReload } = remote;
  const load = useCallback((forceOrRevision: boolean | string = false) => {
    const startedAt = Date.now();
    const force = forceOrRevision === true || typeof forceOrRevision === 'string';
    if (!force && startedAt - lastLoadAt.current < 250) return Promise.resolve();
    lastLoadAt.current = startedAt;
    return remoteReload();
  }, [remoteReload]);
  // useRemoteData owns loadSequence/requestId; if (current !== loadSequence.current), stale responses are discarded.
  useEffect(() => {
    if (!remote.loading && remote.ready) { setProducts(remote.data.products); setCustomers(remote.data.customers); setRecent(remote.data.recent); setReady(true); setLoadError(''); }
    if (remote.loadError) { setReady(false); setLoadError(remote.loadError); }
  }, [remote.loading, remote.ready, remote.loadError, remote.data]);
  useSharedRefresh(load);
  useDidShow(() => {
    const firstShow = !didShowOnce.current;
    didShowOnce.current = true;
    if (!firstShow || remote.loadError) void load(true);
    else if (Date.now() - lastLoadAt.current >= 250) void load();
    const transit = Taro.getStorageSync('sg_transit'); if (!transit) return;
    if (typeof transit.product_id === 'number') setTransitId(transit.product_id);
    if (typeof transit.customer_id === 'number') setCustomerId(transit.customer_id);
    Taro.removeStorageSync('sg_transit');
  });
  useEffect(() => {
    if (!transitId || !ready || submitting) return;
    const product = transitId == null ? undefined : productMap.get(transitId);
    if (product) setLines(current => {
      if (current.some(line => line.product_id === product.id)) return current;
      const blank = current.findIndex(line => !line.product_id);
      return blank < 0 ? [...current, applyProduct(newLine(), product)] : current.map((line, index) => index === blank ? applyProduct(line, product) : line);
    });
    setTransitId(null);
  }, [transitId, productMap, ready, submitting]);
  const updateLine = (key: string, patch: Partial<EditableLine>) => { if (!busy.current) setLines(current => current.map(line => line.key === key ? { ...line, ...patch } : line)); };
  const totalAmount = useMemo(() => { const values = lines.map(line => previewAmount(line.quantity, line.unit_price)); return values.every(Number.isFinite) ? roundDecimal(values.reduce((sum, value) => sum + value, 0), 2) : Number.NaN; }, [lines]);
  const customer = customers.find(item => item.id === customerId);
  const insufficient = useMemo(() => lines.filter(line => { const product = line.product_id == null ? undefined : productMap.get(line.product_id); return product && Number(line.quantity) > roundDecimal(product.stock, 6); }), [lines, productMap]);
  const submit = async () => {
    if (busy.current) return;
    try {
      if (!Number.isFinite(totalAmount)) throw new Error('金额超出支持范围，请减少数量或单价');
      if (!ready || loadError) throw new Error('请先刷新商品与客户数据');
      if (customerId && !customer) throw new Error('客户已停用，请重新选择');
      if (new Set(lines.map(line => line.product_id)).size !== lines.length) throw new Error('同一商品不能重复，请合并数量');
      const payload = lines.map((line, index) => {
        const product = line.product_id == null ? undefined : productMap.get(line.product_id);
        if (!product) throw new Error(`第 ${index + 1} 行请选择有效商品`);
        const quantity = numberValue(line.quantity, `第 ${index + 1} 行数量`, true);
        if (quantity > roundDecimal(product.stock, 6)) throw new Error(`第 ${index + 1} 行库存不足，仅剩 ${product.stock}${product.unit}`);
        return { product_id: product.id, quantity, unit_price: numberValue(line.unit_price, `第 ${index + 1} 行单价`), unit: product.unit };
      });
      busy.current = true; setSubmitting(true);
      const result = await stockOutBatch(payload, operator.trim(), remark.trim(), customerId);
      invalidateProducts();
      setLines([newLine()]); setOperator(''); setRemark(''); setCustomerId(null);
      Taro.showToast({ title: `出库成功，共 ${result.transactions.length} 项`, icon: 'success' }); await load();
    } catch (error) { Taro.showToast({ title: message(error), icon: 'none' }); }
    finally { busy.current = false; setSubmitting(false); }
  };
  const voidRecent = async (transaction: Transaction) => {
    if (busy.current) return;
    busy.current = true; setSubmitting(true);
    try {
      const choice = await Taro.showModal({ title: '作废出库明细', content: `恢复 ${transaction.product_name} 的 ${transaction.quantity}${transaction.unit || ''} 库存并撤回应收，历史记录保留。确定继续吗？`, confirmColor: '#dc2626' });
      if (!choice.confirm) return;
      await deleteTransaction(transaction.id); await load(); Taro.showToast({ title: '已作废并恢复库存', icon: 'success' });
    } catch (error) { Taro.showToast({ title: message(error), icon: 'none' }); }
    finally { busy.current = false; setSubmitting(false); }
  };
  return <ScrollView scrollY className={styles.container} refresherEnabled={false} onRefresherRefresh={() => load(true)}>
    <Text className={styles.sectionTitle}>出库开单</Text>
    {loadError && <View className={styles.error} onClick={() => load(true)}>{loadError} · 点击重试</View>}
    <View className={styles.card}>
      <Text className={styles.fieldLabel}>客户</Text>
      <Picker disabled={submitting} range={['不关联客户', ...customers.map(item => item.name)]} value={Math.max(0, customers.findIndex(item => item.id === customerId) + 1)} onChange={event => { const index = Number(event.detail.value); setCustomerId(index ? customers[index - 1]?.id || null : null); }}><View className={styles.pickerCell}><Text>{customer?.name || (customerId ? '客户已停用，请重新选择' : '选择客户（选填）')}</Text></View></Picker>
      <Text className={styles.infoStock}>{customer ? `当前应收 ${formatMoney(Number(customer.debt || 0))}，本单增加 ${formatMoneyPreview(totalAmount)}` : '未关联客户时，仅扣库存，不登记客户应收'}</Text>
    </View>
    <Text className={styles.sectionTitle}>出库明细（可添加多项）</Text>
    {lines.map((line, index) => {
      const product = line.product_id == null ? undefined : productMap.get(line.product_id);
      const after = product ? roundDecimal(product.stock - (Number(line.quantity) || 0), 6) : 0;
      return <View className={styles.card} key={line.key}>
        <View className={styles.recentTop}><Text className={styles.fieldLabel}>第 {index + 1} 项</Text>{lines.length > 1 && <Text className={styles.deleteBtn} onClick={() => { if (!busy.current) setLines(current => current.filter(item => item.key !== line.key)); }}>移除</Text>}</View>
        <StockProductPicker products={products} value={line.product_id} disabled={submitting} excluded={lines.filter(item => item.key !== line.key).map(item => item.product_id || 0)} onSelect={selected => updateLine(line.key, applyProduct(line, selected))} />
        {product && <View className={after < 0 ? styles.error : styles.stockPreview}><Text>当前库存 {product.stock}{product.unit} → 出库后 {after}{product.unit}</Text><Text className={styles.infoStock}>{product.specification || '未填规格'} · {product.material || product.corrugation || '未填材质'}</Text>{after < 0 && <Text>库存不足，请减少数量</Text>}</View>}
        <View className={styles.field}><Text className={styles.fieldLabel}>出库数量（{product?.unit || '单位'}）</Text><Input disabled={submitting} className={styles.fieldInput} type='digit' placeholder='出库数量' value={line.quantity} onInput={event => updateLine(line.key, { quantity: sanitizeDecimalInput(event.detail.value, 6) })} /></View>
        <View className={styles.field}><Text className={styles.fieldLabel}>单价（元/{product?.unit || '单位'}）</Text><Input disabled={submitting} className={styles.fieldInput} type='digit' placeholder='出库单价' value={line.unit_price} onInput={event => updateLine(line.key, { unit_price: sanitizeDecimalInput(event.detail.value, 2) })} /></View>
        <Text className={styles.amountPreview}>本项金额 {formatMoneyPreview(previewAmount(line.quantity, line.unit_price))}</Text>
        {line.quantity.trim() && line.unit_price.trim() && !Number.isFinite(previewAmount(line.quantity, line.unit_price)) && <Text className={styles.error}>金额超出支持范围，请减少数量或单价</Text>}
      </View>;
    })}
    <View className={styles.addLine} onClick={() => { if (!busy.current) setLines(current => [...current, newLine()]); }}>＋ 添加商品</View>
    <View className={styles.card}>
      <Text className={styles.amountPreview}>共 {lines.length} 项 · 合计出库金额 {formatMoneyPreview(totalAmount)}</Text>{!!insufficient.length && <Text className={styles.error}>有 {insufficient.length} 项库存不足，请调整后提交</Text>}
      <View className={styles.field}><Text className={styles.fieldLabel}>操作人</Text><Input disabled={submitting} className={styles.fieldInput} placeholder='选填，默认当前操作账号' value={operator} onInput={event => setOperator(event.detail.value)} /></View>
      <View className={styles.fieldLast}><Text className={styles.fieldLabel}>备注</Text><Input disabled={submitting} className={styles.fieldInput} value={remark} onInput={event => setRemark(event.detail.value)} /></View>
    </View>
    <View className={`${styles.btnPrimary} ${submitting || !ready ? styles.btnDisabled : ''}`} onClick={submit}>{submitting ? '处理中…' : '确认出库'}</View>
    <Text className={styles.sectionTitle}>最近出库记录</Text>
    <View className={styles.card}>{recent.length ? recent.map(transaction => <RecentOutboundRow key={transaction.id} transaction={transaction} onVoid={voidRecent} />) : <View className={styles.empty}>????</View>}</View>
  </ScrollView>;
}
