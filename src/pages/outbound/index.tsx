import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { View, Text, Input } from '@tarojs/components';
import Taro, { useDidShow, useRouter } from '@tarojs/taro';
import { getOrders, getTransactions, orderOutbound } from '@/services/api';
import { invalidateProducts, loadProducts } from '@/services/product-store';
import { useSharedRefresh } from '@/services/shared-refresh';
import type { CustomerOrder, Product, Transaction } from '@/types';
import { formatMoney, formatShortTime } from '@/utils/format';
import { lineAmount, numberValue, roundDecimal, sanitizeDecimalInput } from '@/utils/stock-math';
import StockProductPicker from '@/components/StockProductPicker';
import { OutboundDocument } from './document';
import styles from './index.module.scss';
import { BoardPage, BoardButton } from '@/components/BoardUI';
import { BoardMaterial } from '@/components/BoardUI/visuals';

export default function OutboundPage() {
  const { params } = useRouter();
  const [orders, setOrders] = useState<CustomerOrder[]>([]);
  const [products, setProducts] = useState<Product[]>([]);
  const [recent, setRecent] = useState<Transaction[]>([]);
  const [query, setQuery] = useState('');
  const [orderId, setOrderId] = useState<number | null>(null);
  const [productId, setProductId] = useState<number | null>(null);
  const [quantity, setQuantity] = useState('');
  const [remark, setRemark] = useState('');
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
    const matches = products.filter(item => !!order.specification && item.specification === order.specification && item.unit === order.unit && (!order.material || item.material === order.material));
    setProductId(matches.length === 1 ? matches[0].id : null);
    setRemark('');
  }, [order, products, remaining, ready]);
  const candidates = useMemo(() => orders.filter(item => item.status === '生产中' && `${item.order_no} ${item.customer_name} ${item.specification}`.toLowerCase().includes(query.toLowerCase())), [orders, query]);
  const notes = useMemo(() => {
    const groups = new Map<string, Transaction[]>();
    recent.forEach(tx => { const key = tx.outbound_no || `历史-${tx.id}`; const rows = groups.get(key); if (rows) rows.push(tx); else groups.set(key, [tx]); });
    return [...groups.entries()].slice(0, 8);
  }, [recent]);
  let totalAmount = quantity.trim() ? Number.NaN : 0;
  if (order && quantity.trim()) {
    try { totalAmount = lineAmount(numberValue(quantity, '出库数量', true), order.unit_price); } catch { /* Keep invalid input visible until corrected. */ }
  }
  const valid = ready && !!order && order.status === '生产中' && !!product && Number.isFinite(totalAmount) && Number(quantity) > 0 && Number(quantity) <= remaining && Number(quantity) <= Number(product.stock) && product.unit === order.unit;
  const submit = async () => {
    if (!Number.isFinite(totalAmount)) { Taro.showToast({ title: '金额超出支持范围，请减少数量或单价', icon: 'none' }); return; }
    if (lock.current || !valid || !order || !product) return;
    lock.current = true; setBusy(true);
    try {
      const result = await orderOutbound(order.id, [{ product_id: product.id, quantity: numberValue(quantity, '出库数量', true), unit_price: order.unit_price, specification: product.specification, unit: product.unit }], '', remark.trim());
      setDocument(result.transactions.map(item => item.transaction));
      setOrderId(null); setProductId(null); invalidateProducts();
      Taro.showToast({ title: '出库成功', icon: 'success' }); await reload();
    } catch (e) { Taro.showToast({ title: e instanceof Error ? e.message : '出库失败', icon: 'none' }); }
    finally { lock.current = false; setBusy(false); }
  };
  return <BoardPage back={false} title='订单出库' subtitle='选订单、核对数量，一键完成发货。' action={<BoardButton secondary disabled={busy} onClick={() => reload()}>刷新</BoardButton>}><View className={styles.container}>
    <View className='board-summary inventory-hero'><View className='inventory-hero-main'><View><Text className='inventory-live'><i /> 发货总览</Text><Text className='board-summary-number'>{ready ? orders.filter(item => item.status === '生产中').length : '—'}<small>单待发</small></Text><Text className='board-muted'>库存校验 · 自动开单 · 交付追踪</Text></View><BoardMaterial /></View><View className='board-summary-bottom'><View><strong>{notes.length}</strong><Text className='board-muted'>最近出库单</Text></View><View><strong>{order ? remaining : '—'}</strong><Text className='board-muted'>本单待发数量</Text></View><View><strong>{order ? formatMoney(order.unit_price) : '—'}</strong><Text className='board-muted'>订单单价</Text></View></View></View>
    {error && <View className={styles.error} onClick={() => reload()}>{error} · 点击重试</View>}
    <View className={styles.card}><View className={styles.recentTop}><Text className={styles.cardTitle}>01 / 选择订单</Text><Text className={styles.link} onClick={() => Taro.navigateTo({ url: '/pages/orders/index' })}>管理订单 →</Text></View>
      <Input disabled={busy} className={styles.fieldInput} placeholder='搜索客户、订单号或规格' value={query} onInput={e => setQuery(e.detail.value)} />
      <View className={styles.orderList}>{candidates.map(item => <View key={item.id} className={`${styles.orderOption} ${item.id === orderId ? styles.orderSelected : ''}`} onClick={() => { if (!lock.current) setOrderId(item.id); }}><View><Text className={styles.recentName}>{item.customer_name || '未关联客户'}</Text><Text className={styles.infoStock}>{item.order_no} · {item.specification || '未填规格'}</Text><Text className={styles.infoStock}>交期 {item.delivery_date || '未定'} · {item.quantity}{item.unit}</Text></View><Text className={styles.tagOut}>{item.id === orderId ? '已选择' : '开单 →'}</Text></View>)}</View>
      {!candidates.length && <View className={styles.empty}>{ready ? '暂无匹配的生产中订单' : '正在加载订单…'}</View>}
    </View>
    {order && <View className={styles.card}><Text className={styles.cardTitle}>02 / 核对出库</Text><Text className={styles.infoStock}>{order.customer_name || '未关联客户'} · {order.order_no}</Text><View className={styles.progress}><Text>订单 {order.quantity}</Text><Text>已发 {shipped}</Text><Text>待发 {remaining}{order.unit}</Text></View>
      <Text className={styles.fieldLabel}>库存商品 · 唯一匹配时自动选择</Text><StockProductPicker products={products} value={productId} disabled={busy} onSelect={item => setProductId(item.id)} />
      <View className={styles.fieldGrid}><View><Text className={styles.fieldLabel}>本次发货（{order.unit}）</Text><Input disabled={busy} className={styles.fieldInput} type='digit' value={quantity} onInput={e => setQuantity(sanitizeDecimalInput(e.detail.value, 6))} /></View><View><Text className={styles.fieldLabel}>订单单价</Text><Text className={styles.fieldInput}>{formatMoney(order.unit_price)}</Text></View></View>
      <Text className={styles.link} onClick={() => { if (!busy) setQuantity(String(remaining)); }}>填入全部待发数量</Text>
      {product && <View className={valid ? styles.stockPreview : styles.error}>{product.unit !== order.unit ? '库存商品单位与订单不一致，请重新选择' : Number(quantity) > product.stock ? `库存不足，还缺 ${roundDecimal(Number(quantity) - product.stock, 6)}${product.unit}` : Number(quantity) > remaining ? '超过订单待发数量' : `当前库存 ${product.stock}${product.unit} · 发货后 ${roundDecimal(product.stock - Number(quantity || 0), 6)}${product.unit}`}</View>}
      <Input disabled={busy} className={styles.fieldInput} placeholder='备注（选填）' value={remark} onInput={e => setRemark(e.detail.value)} />
      <View className={Number.isFinite(totalAmount) ? styles.amountPreview : styles.error}>{Number.isFinite(totalAmount) ? `本单金额 ${formatMoney(totalAmount)}` : '金额超出支持范围，请减少数量或单价'}</View><Text className={styles.infoStock}>确认后自动扣库存、登记应收，并更新订单发货进度</Text>
      <View className={`${styles.btnPrimary} ${busy || !valid ? styles.btnDisabled : ''}`} onClick={submit}>{busy ? '正在出库…' : '确认出库 · 生成送货单'}</View>
    </View>}
    {!!document.length && <OutboundDocument transactions={document} onClose={() => setDocument([])} />}
    <Text className={styles.sectionTitle}>最近出库单</Text><View className={styles.card}>{notes.map(([no, rows]) => <View className={styles.recentItem} key={no}><View className={styles.recentLeft}><Text className={styles.recentName}>{rows[0].customer_name || '未关联客户'} · {no}</Text><Text className={styles.recentTime}>{formatShortTime(rows[0].created_at)} · {rows.length} 项 · {formatMoney(rows.reduce((sum, tx) => sum + Number(tx.amount || 0), 0))}</Text></View><Text className={styles.tagOut} onClick={() => setDocument(rows)}>查看单据</Text></View>)}{!notes.length && <View className={styles.empty}>暂无出库记录</View>}</View>
  </View></BoardPage>;
}
