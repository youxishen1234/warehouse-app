import { useSharedRefresh } from '@/services/shared-refresh';
import React, { useCallback, useEffect, useRef, useState } from 'react';
import { View, Text, Input, Picker, ScrollView } from '@tarojs/components';
import Taro from '@tarojs/taro';
import { addOrder, getCustomers, getOrderEvents, getOrders, updateOrder } from '@/services/api';
import type { Customer, CustomerOrder } from '@/types';
import type { OrderStatusEvent } from '@/services/api';
import styles from './index.module.scss';
import { sanitizeDecimalInput } from '@/utils/stock-math';
import { formatMoney, formatShortTime } from '@/utils/format';

const nextStatusMap: Record<CustomerOrder['status'], CustomerOrder['status'][]> = {
  '待生产': ['待生产', '生产中', '已取消'],
  '生产中': ['生产中', '已发货', '已取消'],
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
  return <View className={styles.item}>
    <View className={styles.itemMain}>
      <Text className={styles.order}>{order.order_no} · {order.customer_name || '未关联客户'}</Text>
      <Text>规格：{order.specification || '未填写'} · 材质：{order.material || '未填写'}</Text>
      <Text>数量 {order.quantity}{order.unit} · 单价 {formatMoney(order.unit_price || 0)} · 金额 {formatMoney(order.amount || 0)}</Text>
      <Text>交期：{order.delivery_date || '未定'}{order.remark ? ` · ${order.remark}` : ''}</Text>
      {history.length > 0 && <View className={styles.events}><Text className={styles.eventsTitle}>状态记录</Text>{history.map(event => <Text key={event.id}>{event.from} → {event.to} · {formatShortTime(event.created_at)}</Text>)}</View>}
    </View>
    <Picker range={nextStatusMap[order.status] || [order.status]} value={0} onChange={event => onStatusChange(order, Number(event.detail.value))}><Text className={styles.status}>{order.status}</Text></Picker>
  </View>;
});

export default function Orders() {
  const [list, setList] = useState<CustomerOrder[]>([]);
  const [customers, setCustomers] = useState<Customer[]>([]);
  const [events, setEvents] = useState<Record<number, OrderStatusEvent[]>>({});
  const [show, setShow] = useState(false);
  const [orderNo, setOrderNo] = useState('');
  const [spec, setSpec] = useState('');
  const [material, setMaterial] = useState('');
  const [qty, setQty] = useState('1');
  const [price, setPrice] = useState('0');
  const [delivery, setDelivery] = useState('');
  const [remark, setRemark] = useState('');
  const [customer, setCustomer] = useState<number | null>(null);
  const [saving, setSaving] = useState(false);
  const [loading, setLoading] = useState(true);
  const [loadError, setLoadError] = useState('');
  const loadSequence = useRef(0);
  const lastLoadAt = useRef(0);

  const load = useCallback(async (forceOrRevision: boolean | string | object = false) => {
    const startedAt = Date.now();
    const force = forceOrRevision === true || typeof forceOrRevision === 'string';
    if (!force && startedAt - lastLoadAt.current < 250) return;
    lastLoadAt.current = startedAt;
    const sequence = ++loadSequence.current;
    setLoading(true); setLoadError('');
    try {
      const [orders, customerList] = await Promise.all([getOrders(), getCustomers()]);
      if (sequence !== loadSequence.current) return;
      setList(orders);
      setCustomers(customerList);
      const pairs = await Promise.all(orders.map(async order => [order.id, await getOrderEvents(order.id)] as const));
      if (sequence !== loadSequence.current) return;
      setEvents(Object.fromEntries(pairs));
    } catch (error) {
      if (sequence === loadSequence.current) setLoadError(error instanceof Error ? error.message : '订单加载失败，请点击重试');
    } finally {
      if (sequence === loadSequence.current) setLoading(false);
    }
  }, []);

  useSharedRefresh(load);
  useEffect(() => { load(); }, [load]);
  useEffect(() => () => { loadSequence.current += 1; }, []);

  const resetForm = () => {
    setOrderNo(''); setSpec(''); setMaterial(''); setQty('1'); setPrice('0'); setDelivery(''); setRemark(''); setCustomer(null);
  };

  const save = async () => {
    if (loadError || loading) { Taro.showToast({ title: '订单资料仍在加载，请先重试', icon: 'none' }); return; }
    if (!orderNo.trim()) { Taro.showToast({ title: '请输入订单号', icon: 'none' }); return; }
    const quantity = Number(qty);
    const unitPrice = Number(price);
    if (!Number.isFinite(quantity) || quantity <= 0) { Taro.showToast({ title: '数量必须大于 0', icon: 'none' }); return; }
    if (!Number.isFinite(unitPrice) || unitPrice < 0) { Taro.showToast({ title: '单价格式不正确', icon: 'none' }); return; }
    if (saving) return;
    setSaving(true);
    try {
      const c = customers.find(item => item.id === customer);
      await addOrder({ order_no: orderNo.trim(), customer_id: customer, customer_name: c?.name || '', specification: spec, material, quantity, unit: '件', unit_price: unitPrice, delivery_date: delivery, status: '待生产', remark });
      Taro.showToast({ title: '订单保存成功', icon: 'success' });
      resetForm(); setShow(false); await load();
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

  return <ScrollView scrollY className={styles.page} onRefresherRefresh={load} refresherEnabled>
    <View className={styles.header}><Text>客户订单</Text><View onClick={() => setShow(!show)}>{show ? '关闭' : '＋新增订单'}</View></View>
    {loading && <View className={styles.empty}>正在加载订单资料…</View>}
    {loadError && <View className={styles.empty} onClick={load}>{loadError} · 点击重试</View>}
    {!loading && !loadError && show && <View className={styles.form}>
      <Input placeholder="订单号" value={orderNo} onInput={e => setOrderNo(e.detail.value)} />
      <Picker range={customers.map(c => c.name)} onChange={e => setCustomer(customers[Number(e.detail.value)]?.id || null)}><View>选择客户（可选）</View></Picker>
      <Input placeholder="规格（可选，如 300×200×150mm）" value={spec} onInput={e => setSpec(e.detail.value)} />
      <Input placeholder="材质（可选，如五层AB楞）" value={material} onInput={e => setMaterial(e.detail.value)} />
      <Input type="number" placeholder="数量" value={qty} onInput={e => setQty(sanitizeDecimalInput(e.detail.value, 6))} />
      <Input type="digit" placeholder="单价" value={price} onInput={e => setPrice(sanitizeDecimalInput(e.detail.value, 2))} />
      <Picker mode="date" value={delivery} onChange={e => setDelivery(e.detail.value)}><View>交货日期：{delivery || '未设置'}</View></Picker>
      <Input placeholder="备注（可选）" value={remark} onInput={e => setRemark(e.detail.value)} />
      <View className={styles.save} onClick={save}>{saving ? '保存中…' : '保存订单'}</View>
    </View>}
    {!loading && !loadError && (list.length === 0 ? <View className={styles.empty}>暂无订单</View> : list.map(order => <OrderListRow
      key={order.id}
      order={order}
      history={events[order.id] || []}
      onStatusChange={changeStatus}
    />))}
  </ScrollView>;
}
