import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { View, Text, Input, Picker, Button } from '@tarojs/components';
import Taro, { useDidShow, useRouter } from '@tarojs/taro';
import { getOrders, getTransactions, orderOutbound } from '@/services/api';
import { invalidateProducts, loadProducts } from '@/services/product-store';
import { useSharedRefresh } from '@/services/shared-refresh';
import type { CustomerOrder, Product, Transaction } from '@/types';
import { formatMoney, formatShortTime } from '@/utils/format';
import { lineAmount, localDate, numberValue, roundDecimal, sanitizeDecimalInput } from '@/utils/stock-math';
import StockProductPicker from '@/components/StockProductPicker';
import { formatSpecificationInput } from '@/pages/print-center/specification-input';
import { OutboundDocument } from '@/components/BusinessForms/Shipment/document';
import styles from '@/components/BusinessForms/Receipt/index.module.scss';
import StockEntryLayout from '@/components/StockEntryLayout';

export default function OutboundPage() {
  const { params } = useRouter();
  const [orders, setOrders] = useState<CustomerOrder[]>([]);
  const [products, setProducts] = useState<Product[]>([]);
  const [recent, setRecent] = useState<Transaction[]>([]);
  const [query, setQuery] = useState('');
  const [orderId, setOrderId] = useState<number | null>(null);
  const [productId, setProductId] = useState<number | null>(null);
  const [specification, setSpecification] = useState('');
  const [quantity, setQuantity] = useState('');
  const [date, setDate] = useState(() => localDate());
  const [remark, setRemark] = useState('');
  const [detailsOpen, setDetailsOpen] = useState(false);
  const [historyOpen, setHistoryOpen] = useState(false);
  const [searchOpen, setSearchOpen] = useState(false);
  const [busy, setBusy] = useState(false);
  const [ready, setReady] = useState(false);
  const [error, setError] = useState('');
  const [document, setDocument] = useState<Transaction[]>([]);
  const lock = useRef(false);
  const sequence = useRef(0);
  const initializedOrder = useRef<number | null>(null);
  const productMap = useMemo(() => new Map(products.map(item => [item.id, item])), [products]);
  const orderMap = useMemo(() => new Map(orders.map(item => [item.id, item])), [orders]);
  const shippedByOrder = useMemo(() => {
    const totals = new Map<number, number>();
    for (const tx of recent) if (tx.order_id != null && !tx.voided_at) totals.set(tx.order_id, (totals.get(tx.order_id) || 0) + tx.quantity);
    return totals;
  }, [recent]);
  const order = orderId === null ? undefined : orderMap.get(orderId);
  const product = productId === null ? undefined : productMap.get(productId);
  const shipped = roundDecimal(orderId === null ? 0 : shippedByOrder.get(orderId) || 0, 6);
  const remaining = order ? roundDecimal(order.quantity - shipped, 6) : 0;
  const reload = useCallback(async () => {
    const current = ++sequence.current;
    setReady(false);
    try {
      const [o, p, t] = await Promise.all([getOrders(), loadProducts(true), getTransactions({ type: 'out' })]);
      if (current !== sequence.current) return;
      setOrders(o); setProducts(p); setRecent(t); setReady(true); setError('');
    } catch (e) { if (current === sequence.current) { setReady(false); setError(e instanceof Error ? e.message : '加载失败，请重试'); } }
  }, []);
  useEffect(() => () => { sequence.current += 1; }, []);
  useSharedRefresh(reload);
  useDidShow(() => {
    void reload();
    const id = Taro.getStorageSync('sg_outbound_order');
    if (params.order_id && /^\d+$/.test(params.order_id)) setOrderId(Number(params.order_id));
    else if (id) setOrderId(Number(id));
    if (id) Taro.removeStorageSync('sg_outbound_order');
  });
  useEffect(() => {
    if (!order) { initializedOrder.current = null; return; }
    // A refreshed order/product object must not replace an in-progress draft.
    if (!ready || initializedOrder.current === order.id) return;
    initializedOrder.current = order.id;
    setQuantity(String(remaining));
    setSpecification(order.specification || '');
    const matches = products.filter(item => !!order.specification && item.specification === order.specification && item.unit === order.unit && (!order.material || item.material === order.material));
    setProductId(matches.length === 1 ? matches[0].id : null);
    setRemark('');
  }, [order, products, remaining, ready]);
  useEffect(() => {
    if (!product) return;
    // Keep a hand-edited specification; only a fresh product selection replaces it.
    setSpecification(current => current.trim() || product.specification || '');
  }, [product]);
  const candidates = useMemo(() => orders.filter(item => (item.status === '待发货' || item.status === '生产中') && `${item.order_no} ${item.customer_name} ${item.specification}`.toLowerCase().includes(query.toLowerCase())), [orders, query]);
  const notes = useMemo(() => {
    const groups = new Map<string, Transaction[]>();
    recent.forEach(tx => { const key = tx.outbound_no || `历史-${tx.id}`; const rows = groups.get(key); if (rows) rows.push(tx); else groups.set(key, [tx]); });
    return [...groups.entries()].slice(0, 8);
  }, [recent]);
  let totalAmount = quantity.trim() ? Number.NaN : 0;
  if (order && quantity.trim()) {
    try { totalAmount = lineAmount(numberValue(quantity, '出库数量', true), order.unit_price); } catch { /* Keep invalid input visible until corrected. */ }
  }
  const valid = ready && !!order && (order.status === '待发货' || order.status === '生产中') && !!product && !!specification.trim() && Number.isFinite(totalAmount) && Number(quantity) > 0 && Number(quantity) <= remaining && Number(quantity) <= Number(product.stock) && product.unit === order.unit;
  const submit = async () => {
    if (!Number.isFinite(totalAmount)) { Taro.showToast({ title: '金额超出支持范围，请减少数量或单价', icon: 'none' }); return; }
    if (lock.current || !valid || !order || !product) return;
    lock.current = true; setBusy(true);
    try {
      const result = await orderOutbound(order.id, [{ product_id: product.id, quantity: numberValue(quantity, '出库数量', true), unit_price: order.unit_price, specification: specification.trim(), unit: product.unit }], '', remark.trim());
      setDocument(result.transactions.map(item => item.transaction));
      setOrderId(null); setProductId(null); invalidateProducts();
      Taro.showToast({ title: '出库成功', icon: 'success' }); await reload();
    } catch (e) { Taro.showToast({ title: e instanceof Error ? e.message : '出库失败', icon: 'none' }); }
    finally { lock.current = false; setBusy(false); }
  };
  const unit = product?.unit || order?.unit || '单位';
  return <StockEntryLayout title='出库' subtitle='选货物，填数量，确认保存。' onRefresh={() => void reload()} busy={busy}>
    <View className={styles.page}>
      <Text className={styles.hint}>可选待发货订单（成品已入库）或旧流程的生产中订单；出库时扣减纸箱库存并记入对应客户账单。</Text>
      {error && <View role='alert' className={styles.error}>{error}<Button disabled={busy} className={styles.textButton} onClick={() => { void reload(); }}>重新读取</Button></View>}
      <View className={styles.field}>
        <View className={styles.row}><Text className={styles.fieldLabel}>客户 / 订单</Text><Button disabled={busy} className={styles.textButton} aria-expanded={searchOpen} onClick={() => setSearchOpen(!searchOpen)}>{searchOpen ? '收起搜索' : '查找订单'}</Button></View>
        {searchOpen && <Input aria-label='搜索客户、订单号或规格' disabled={busy} className={styles.input} placeholder='搜索客户、订单号或规格' value={query} onInput={e => setQuery(e.detail.value)} />}
        <Picker disabled={busy || !ready} range={['选择客户 / 订单', ...candidates.map(item => `${item.customer_name || '未关联客户'} · ${item.order_no} · ${item.specification || '未填规格'} · ${item.status}`)]} value={Math.max(0, candidates.findIndex(item => item.id === orderId) + 1)} onChange={e => { if (!lock.current) setOrderId(candidates[Number(e.detail.value) - 1]?.id || null); }}>
          <View className={styles.picker} aria-label='客户 / 订单'>{order ? `${order.customer_name || '未关联客户'} · ${order.order_no}` : ready ? '选择客户 / 订单' : '正在读取订单…'}<Text>⌄</Text></View>
        </Picker>
        {!candidates.length && <Text className={styles.hint}>{ready ? '暂无匹配的可出库订单' : '正在加载订单…'}</Text>}
      </View>
      <View className={styles.field}><Text className={styles.fieldLabel}>货物名称</Text><StockProductPicker products={products} value={productId} disabled={busy || !ready || !order} onSelect={item => { if (!lock.current) { setProductId(item.id); setSpecification(item.specification || order?.specification || ''); } }} /></View>
      <View className={styles.field}><Text className={styles.fieldLabel}>规格尺寸</Text><Input aria-label='出库规格尺寸' disabled={busy} className={styles.input} value={specification} placeholder='选择订单和货物后自动带入' onInput={e => setSpecification(formatSpecificationInput(e.detail.value, specification))} /></View>
      <View className={styles.grid}>
        <View><Text className={styles.fieldLabel}>出库数量（{unit}）</Text><Input aria-label='出库数量' disabled={busy || !order} className={styles.input} type='digit' value={quantity} onInput={e => setQuantity(sanitizeDecimalInput(e.detail.value, 6))} /></View>
        <View><Text className={styles.fieldLabel}>单价（元/{unit}）</Text><View className={styles.input}>{order ? formatMoney(order.unit_price) : '自动带入'}</View></View>
      </View>
      {order && <Button disabled={busy} className={styles.addLine} onClick={() => setQuantity(String(Math.max(0, remaining)))}>填入全部待发数量</Button>}
      {product && <Text className={valid ? styles.hint : styles.error}>{product.unit !== order?.unit ? '库存商品单位与订单不一致，请重新选择' : Number(quantity) > product.stock ? `库存不足，还缺 ${roundDecimal(Number(quantity) - product.stock, 6)}${product.unit}` : Number(quantity) > remaining ? '超过订单待发数量' : `当前库存 ${product.stock}${product.unit} → 出库后 ${roundDecimal(product.stock - Number(quantity || 0), 6)}${product.unit}`}</Text>}
      <View className={styles.field}><Text className={styles.fieldLabel}>业务日期</Text><Picker aria-label='业务日期' disabled={busy} mode='date' value={date} onChange={e => setDate(e.detail.value)}><View className={styles.picker}>{date}<Text>⌄</Text></View></Picker></View>
      <Button disabled={busy} className={styles.detailsToggle} aria-expanded={detailsOpen} onClick={() => setDetailsOpen(!detailsOpen)}><Text>更多信息</Text><Text>{detailsOpen ? '收起 −' : '展开 ＋'}</Text></Button>
      {detailsOpen && <View className={styles.detailsBody}>
        {order && <Text className={styles.hint}>订单 {order.quantity}{order.unit} · 已发 {shipped}{order.unit} · 待发 {remaining}{order.unit}</Text>}
        <View className={styles.field}><Text className={styles.fieldLabel}>备注</Text><Input aria-label='出库备注' disabled={busy} className={styles.input} maxlength={500} placeholder='备注（选填）' value={remark} onInput={e => setRemark(e.detail.value)} /></View>
        <Button disabled={busy} className={styles.addLine} onClick={() => Taro.navigateTo({ url: '/pages/management/index?section=orders' })}>管理订单</Button>
      </View>}
      <View className={styles.total}><Text>1 项货物</Text><Text>{Number.isFinite(totalAmount) ? `本单金额 ${formatMoney(totalAmount)}` : '金额超出支持范围'}</Text></View>
      <Button data-testid='outbound-save' aria-label='出库确认' disabled={busy || !valid} className={styles.saveButton} onClick={submit}>{busy ? '正在出库…' : '确认出库'}</Button>
      {!!document.length && <OutboundDocument transactions={document} onClose={() => setDocument([])} />}
      <Button disabled={busy} className={styles.historyToggle} aria-expanded={historyOpen} onClick={() => setHistoryOpen(!historyOpen)}><Text>最近出库单</Text><Text>{historyOpen ? '收起 −' : '查看 ＋'}</Text></Button>
      {historyOpen && (!notes.length ? <View className={styles.empty}>暂无出库记录</View> : notes.map(([no, rows]) => <View className={styles.note} key={no}>
        <View className={styles.noteTop}><Text>{rows[0].customer_name || '未关联客户'} · {no}</Text><Text className={styles.noteAmount}>{formatMoney(rows.reduce((sum, tx) => sum + Number(tx.amount || 0), 0))}</Text></View>
        <Text className={styles.noteMeta}>{formatShortTime(rows[0].created_at)} · {rows.length} 项</Text>
        <Button disabled={busy} className={styles.textButton} onClick={() => setDocument(rows)}>查看单据</Button>
      </View>))}
    </View>
  </StockEntryLayout>;
}
