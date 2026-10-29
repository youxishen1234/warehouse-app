import { useSharedRefresh } from '@/services/shared-refresh';
import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
/* eslint-disable react/forbid-elements */
import Taro, { useRouter } from '@tarojs/taro';
import { addOrder, getCartonInboundCustomers, getOrderEvents, getOrders, updateOrder } from '@/services/api';
import type { Customer, CustomerOrder, CustomerSpec, Product } from '@/types';
import type { OrderStatusEvent } from '@/services/api';
import { DemoPage, DemoSheet, DemoField, closeBusinessSheet } from '@/components/DemoUI';
import { loadProducts } from '@/services/product-store';
import { sanitizeDecimalInput } from '@/utils/stock-math';
import { formatMoney, formatShortTime } from '@/utils/format';
import { useRemoteData } from '@/hooks/useRemoteData';


const nextStatusMap: Record<CustomerOrder['status'], CustomerOrder['status'][]> = {
  '待生产': ['待生产', '生产中', '待发货', '已取消'],
  '生产中': ['生产中', '待发货', '已发货', '已取消'],
  '待发货': ['待发货', '已取消'],
  '已发货': ['已发货', '已完成'],
  '已完成': ['已完成'],
  '已取消': ['已取消']
};

type OrderListRowProps = {
  order: CustomerOrder;
  history: OrderStatusEvent[];
  onStatusChange: (order: CustomerOrder, index: number) => void;
};

// Order rows are read-only apart from the status picker. Keeping them memoized
// avoids rebuilding every history entry when the add-order form is edited.
const OrderListRow = React.memo(function OrderListRow({ order, history, onStatusChange }: OrderListRowProps) {
  return <article className='demo-card' data-testid={`order-card-${order.id}`}>
    <div className='demo-row'><span className='demo-avatar'>{Array.from(order.customer_name || '客')[0]}</span><div><h3>{order.customer_name || '未关联客户'}</h3><div className='demo-meta'>{order.order_no}</div></div><span className='demo-badge'>{order.status}</span></div>
    <div className='demo-goods'><span>{order.specification || '规格未记录'}</span><span>{order.quantity} {order.unit}</span></div>
    <div className='demo-card-foot'><span>{order.delivery_date || '未设交期'} · {formatMoney(order.amount)}</span><div className='demo-row'>
      <select aria-label={`订单 ${order.order_no} 状态`} value={order.status} onChange={event => onStatusChange(order, (nextStatusMap[order.status] || [order.status]).indexOf(event.target.value as CustomerOrder['status']))}>{(nextStatusMap[order.status] || [order.status]).map(status => <option key={status}>{status}</option>)}</select>
      {(order.status === '待发货' || order.status === '生产中') && <button type='button' className='demo-action' onClick={() => { Taro.setStorageSync('sg_outbound_order', order.id); void Taro.navigateTo({ url: '/pages/management/index?section=shipment' }); }}>确认出库</button>}
    </div></div>
    {history.length > 0 && <details className='demo-more'><summary>状态记录</summary>{history.map(event => <p key={event.id}>{event.from} → {event.to} · {formatShortTime(event.created_at)}</p>)}</details>}
  </article>;
});

export default function Orders() {
  const { params } = useRouter();
  const [list, setList] = useState<CustomerOrder[]>([]);
  const [customers, setCustomers] = useState<Customer[]>([]);
  const [events, setEvents] = useState<Record<number, OrderStatusEvent[]>>({});
  const [show, setShow] = useState(() => params.create === '1');
  const [orderNo, setOrderNo] = useState('');
  const [spec, setSpec] = useState('');
  const [material, setMaterial] = useState('');
  const [qty, setQty] = useState('');
  const [price, setPrice] = useState('');
  const [delivery, setDelivery] = useState('');
  const [remark, setRemark] = useState('');
  const [customer, setCustomer] = useState<number | null>(() => params.customer_id && /^[1-9]\d*$/.test(params.customer_id) ? Number(params.customer_id) : null);
  const [unit, setUnit] = useState('个');
  const [stock, setStock] = useState<Product[]>([]);
  const [specId, setSpecId] = useState('');
  const initialSpecApplied = useRef(false);
  const [query, setQuery] = useState('');
  const [saving, setSaving] = useState(false);

  // A stable loader prevents every state update from starting another request.
  const loadOrders = useCallback(async () => {
    const [orders, customerList, products] = await Promise.all([getOrders(), getCartonInboundCustomers(), loadProducts(true)]);
    const pairs = await Promise.all(orders.map(async order => [order.id, await getOrderEvents(order.id)] as const));
    return { orders, customerList, products, events: Object.fromEntries(pairs) as Record<number, OrderStatusEvent[]> };
  }, []);
  const remote = useRemoteData(loadOrders, { orders: [] as CustomerOrder[], customerList: [] as Customer[], products: [] as Product[], events: {} as Record<number, OrderStatusEvent[]> });
  useEffect(() => {
    if (!remote.loading && remote.ready) {
      setList(remote.data.orders);
      setCustomers(remote.data.customerList);
      setStock(remote.data.products);
      setEvents(remote.data.events);
    }
  }, [remote.loading, remote.ready, remote.data]);

  const load = remote.reload;
  useSharedRefresh(load);

  const resetForm = () => {
    setOrderNo(''); setSpec(''); setMaterial(''); setQty(''); setPrice(''); setDelivery(''); setRemark(''); setCustomer(null); setUnit('个'); setSpecId('');
  };

  const save = async () => {
    if (remote.loadError || remote.loading) { Taro.showToast({ title: '订单资料仍在加载，请先重试', icon: 'none' }); return; }
    if (!customer || !spec.trim()) { Taro.showToast({ title: '请选择客户和常用货物，或补充货物规格', icon: 'none' }); return; }
    const quantity = Number(qty);
    const unitPrice = Number(price);
    if (!Number.isFinite(quantity) || quantity <= 0) { Taro.showToast({ title: '数量必须大于 0', icon: 'none' }); return; }
    if (!price.trim() || !Number.isFinite(unitPrice) || unitPrice < 0) { Taro.showToast({ title: '单价格式不正确', icon: 'none' }); return; }
    if (saving) return;
    setSaving(true);
    try {
      const c = customers.find(item => item.id === customer);
      await addOrder({ order_no: orderNo.trim() || `XS-${new Date().toISOString().replace(/[-:TZ.]/g, '').slice(0, 17)}`, customer_id: customer, customer_name: c?.name || '', specification: spec, material, quantity, unit, unit_price: unitPrice, delivery_date: delivery, status: '待发货', remark });
      Taro.showToast({ title: '订单保存成功', icon: 'success' });
      resetForm(); setShow(false); await load(); if (params.create === '1') closeBusinessSheet();
    } catch (error) {
      Taro.showToast({ title: error?.message || '订单保存失败', icon: 'none' });
    } finally { setSaving(false); }
  };

  const changeStatus = useCallback(async (order: CustomerOrder, index: number) => {
    const options = nextStatusMap[order.status] || [order.status];
    const next = options[index];
    if (next === order.status) return;
    try {
      await updateOrder(order.id, { status: next });
      Taro.showToast({ title: '状态已更新', icon: 'success' });
      await load();
    } catch (error) { Taro.showToast({ title: error?.message || '状态更新失败', icon: 'none' }); }
  }, [load]);

  const selectedCustomer = customers.find(item => item.id === customer);
  const goods = useMemo(() => (selectedCustomer?.specs || []).filter(item => item.category !== '纸板' && item.kind !== '纸板'), [selectedCustomer]);
  const chooseSpec = (item?: CustomerSpec) => {
    setSpecId(item?.id || ''); setSpec(item?.specification || ''); setMaterial(item?.material || '');
    setUnit(item?.unit || '个'); setPrice(item?.price == null ? '' : String(item.price));
  };
  useEffect(() => {
    if (initialSpecApplied.current || !params.customer_id || !selectedCustomer) return;
    const first = goods.find(item => item.id === params.spec_id) || goods[0];
    if (first) chooseSpec(first);
    initialSpecApplied.current = true;
  }, [selectedCustomer, goods, params.customer_id, params.spec_id]);
  const available = stock.filter(item => !item.deleted_at && (!item.customer_id || item.customer_id === customer) && item.specification?.replace(/\s/g, '') === spec.replace(/\s/g, '') && (!material || item.material === material) && item.unit === unit).reduce((sum, item) => sum + item.stock, 0);
  const close = () => params.create === '1' ? closeBusinessSheet() : setShow(false);
  return <>
    {params.create !== '1' && <DemoPage title='客户订单' subtitle='从客户开单开始，沿原单继续办理' action={<button type='button' className='demo-action' onClick={() => setShow(true)}>＋ 客户开单</button>}>
      <input type='search' className='demo-search' aria-label='搜索客户订单' placeholder='搜索客户、规格或订单号' value={query} onChange={event => setQuery(event.target.value)} />
      {remote.loading && <div className='demo-empty'>正在读取订单…</div>}
      {remote.loadError && <div className='demo-error' role='alert'>{remote.loadError}<button type='button' className='demo-action' onClick={() => void load()}>重新读取</button></div>}
      {!remote.loading && !remote.loadError && list.filter(order => [order.customer_name, order.order_no, order.specification].join(' ').includes(query)).map(order => <OrderListRow key={order.id} order={order} history={events[order.id] || []} onStatusChange={changeStatus} />)}
      {!remote.loading && !remote.loadError && !list.length && <div className='demo-empty'>暂无订单</div>}
    </DemoPage>}
    {show && <DemoSheet title={params.customer_id && selectedCustomer ? `给${selectedCustomer.name}开单` : '客户开单'} onClose={close} busy={saving} testId='customer-order-sheet'>
      <p>{params.customer_id ? '客户、规格、价格和地址已带入，只修改本次数量与交期。' : '选客户带出常用货物和历史价格，只改这次的数量。'}</p>
      {remote.loading && <p role='status'>正在读取客户和货物…</p>}
      {remote.loadError && <div role='alert' className='demo-error'>{remote.loadError}<button type='button' className='demo-action' onClick={() => void load()}>重新读取</button></div>}
      {!params.customer_id && <DemoField label='客户'><select aria-label='选择订单客户' data-testid='order-customer-picker' disabled={saving || remote.loading} value={customer || ''} onChange={event => { const next = customers.find(item => item.id === Number(event.target.value)); setCustomer(next?.id || null); chooseSpec((next?.specs || []).find(item => item.category !== '纸板' && item.kind !== '纸板')); }}><option value=''>选择客户</option>{customers.filter(item => !item.deleted_at).map(item => <option value={item.id} key={item.id}>{item.name}</option>)}</select></DemoField>}
      <DemoField label='常用货物 / 规格'><select aria-label='常用货物 / 规格' value={specId} disabled={saving || !customer} onChange={event => chooseSpec(goods.find(item => item.id === event.target.value))}><option value=''>{goods.length ? '选择常用货物' : '暂无常用货物'}</option>{goods.map(item => <option key={item.id} value={item.id}>{item.goods} · {item.specification}</option>)}</select></DemoField>
      <div className='demo-two'><DemoField label={`数量（${unit || '个'}）`}><input aria-label='订单数量' type='number' min='0' step='any' value={qty} disabled={saving} onChange={event => setQty(sanitizeDecimalInput(event.target.value, 6))} /></DemoField><DemoField label='单价（元）'><input aria-label='订单单价' type='number' min='0' step='0.01' value={price} disabled={saving} onChange={event => setPrice(sanitizeDecimalInput(event.target.value, 2))} /></DemoField></div>
      <DemoField label='交货日期'><input aria-label='交货日期' type='date' value={delivery} disabled={saving} onChange={event => setDelivery(event.target.value)} /></DemoField>
      <div className='demo-note' data-testid='order-stock-flow'>{spec ? `可用库存：${spec} · ${available} ${unit}${Number(qty) > available ? `，缺货 ${Number(qty) - available} ${unit}` : '，库存充足可继续出库'}` : '选择货物后显示可用库存'}</div>
      {!!customer && (!goods.length || !specId) && <details className='demo-more' open={!goods.length && !!customer}><summary>填写新货物规格</summary><DemoField label='规格'><input type='text' aria-label='订单规格' value={spec} disabled={saving} onChange={event => setSpec(event.target.value)} /></DemoField><DemoField label='材质'><input type='text' aria-label='订单材质' value={material} disabled={saving} onChange={event => setMaterial(event.target.value)} /></DemoField><DemoField label='单位'><select aria-label='订单单位' value={unit} disabled={saving} onChange={event => setUnit(event.target.value)}>{['个', '件', '箱', '千克'].map(value => <option key={value}>{value}</option>)}</select></DemoField></details>}

      <button type='button' className='demo-primary' disabled={saving || remote.loading || !!remote.loadError} onClick={() => void save()}>{saving ? '正在保存…' : '保存订单 · 自动检查库存'}</button>
    </DemoSheet>}
  </>;
}
