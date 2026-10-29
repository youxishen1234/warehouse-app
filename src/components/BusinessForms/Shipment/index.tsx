import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
/* eslint-disable react/forbid-elements */
import Taro, { useDidShow, useRouter } from '@tarojs/taro';
import { getOrders, getTransactions, orderOutbound } from '@/services/api';
import { invalidateProducts, loadProducts } from '@/services/product-store';
import { useSharedRefresh } from '@/services/shared-refresh';
import type { CustomerOrder, Product, Transaction } from '@/types';
import { formatMoney, formatShortTime } from '@/utils/format';
import { lineAmount, localDate, numberValue, roundDecimal, sanitizeDecimalInput } from '@/utils/stock-math';
import { DemoSheet, DemoField, DemoDetail } from '@/components/DemoUI';
import { formatSpecificationInput } from '@/pages/print-center/specification-input';
import { OutboundDocument } from '@/components/BusinessForms/Shipment/document';



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
  return <DemoSheet title='确认客户出库' busy={busy} testId='shipment-sheet'>
    <p>以下资料来自客户订单，无需重新填写。</p>
    {error && <div role='alert' className='demo-error'>{error}<button type='button' disabled={busy} className='demo-action' onClick={() => void reload()}>重新读取</button></div>}
    <DemoField label='客户 / 订单'><select aria-label='客户 / 订单' value={orderId || ''} disabled={busy || !ready} onChange={event => { if (!lock.current) setOrderId(Number(event.target.value) || null); }}><option value=''>选择客户 / 订单</option>{candidates.map(item => <option key={item.id} value={item.id}>{item.customer_name} · {item.order_no}</option>)}</select></DemoField>
    {!candidates.length && <p>{ready ? '暂无匹配的可出库订单' : '正在读取订单…'}</p>}
    {order && <><DemoDetail label='客户'>{order.customer_name || '未关联客户'}</DemoDetail><DemoDetail label='货物规格'>{order.specification || '规格未记录'}</DemoDetail><DemoDetail label='订单数量'>{order.quantity} {order.unit}</DemoDetail><DemoDetail label='订单金额'>{formatMoney(order.amount)}</DemoDetail></>}
    <DemoField label='出库货物'><select aria-label='出库货物' value={productId || ''} disabled={busy || !ready || !order} onChange={event => { const chosen = products.find(item => item.id === Number(event.target.value)); if (chosen && !lock.current) { setProductId(chosen.id); setSpecification(chosen.specification || order?.specification || ''); } }}><option value=''>选择对应库存货物</option>{products.map(item => <option key={item.id} value={item.id}>{item.name} · {item.specification} · 库存 {item.stock} {item.unit}</option>)}</select></DemoField>
    <DemoField label={`本次出库数量（${unit}）`}><input aria-label='出库数量' disabled={busy || !order} type='number' min='0' step='any' value={quantity} onChange={event => setQuantity(sanitizeDecimalInput(event.target.value, 6))} /></DemoField>
    {product && <div className={valid ? 'demo-note' : 'demo-error'}>{product.unit !== order?.unit ? '库存商品单位与订单不一致，请重新选择' : Number(quantity) > product.stock ? `库存不足，还缺 ${roundDecimal(Number(quantity) - product.stock, 6)} ${product.unit}` : Number(quantity) > remaining ? '超过订单待发数量' : `当前库存 ${product.stock} ${product.unit} → 出库后 ${roundDecimal(product.stock - Number(quantity || 0), 6)} ${product.unit}`}</div>}
    <details className='demo-more'><summary>规格与备注</summary><DemoField label='出库规格尺寸'><input type='text' aria-label='出库规格尺寸' disabled={busy} value={specification} onChange={event => setSpecification(formatSpecificationInput(event.target.value, specification))} /></DemoField><DemoField label='业务日期'><input type='date' aria-label='业务日期' value={date} onChange={event => setDate(event.target.value)} /></DemoField><DemoField label='备注'><input type='text' aria-label='出库备注' maxLength={500} disabled={busy} value={remark} onChange={event => setRemark(event.target.value)} /></DemoField>{order && <p>已发 {shipped} {order.unit} · 待发 {remaining} {order.unit}</p>}<button type='button' className='demo-action' disabled={busy} onClick={() => setQuantity(String(Math.max(0, remaining)))}>填入全部待发数量</button></details>
    <button type='button' className='demo-primary' data-testid='outbound-save' aria-label='出库确认' disabled={busy || !valid} onClick={() => void submit()}>{busy ? '正在出库…' : '确认出库 · 自动生成应收'}</button>
    {!!document.length && <OutboundDocument transactions={document} onClose={() => setDocument([])} />}
    <details className='demo-more'><summary>最近出库单</summary><DemoField label='查找订单'><input type='search' aria-label='搜索客户、订单号或规格' value={query} onChange={event => setQuery(event.target.value)} /></DemoField>{notes.map(([no, rows]) => <button type='button' className='demo-card' key={no} onClick={() => setDocument(rows)}>{rows[0].customer_name} · {no}<p>{formatShortTime(rows[0].created_at)} · {formatMoney(rows.reduce((sum, tx) => sum + Number(tx.amount || 0), 0))}</p></button>)}{!notes.length && <p>暂无出库记录</p>}</details>
  </DemoSheet>;
}
