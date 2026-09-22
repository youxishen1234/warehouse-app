import { useSharedRefresh } from '@/services/shared-refresh';
import React, { useCallback, useEffect, useState } from 'react';
import { View, Text, Input, Picker, ScrollView } from '@tarojs/components';
import Taro from '@tarojs/taro';
import { addOrder, getCustomers, getOrderEvents, getOrders, updateOrder } from '@/services/api';
import type { Customer, CustomerOrder } from '@/types';
import type { OrderStatusEvent } from '@/services/api';
import styles from './index.module.scss';

const statuses: CustomerOrder['status'][] = ['待生产', '生产中', '已发货', '已完成'];

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

  const load = useCallback(async () => {
    try {
      const [orders, customerList] = await Promise.all([getOrders(), getCustomers()]);
      setList(orders);
      setCustomers(customerList);
      const pairs = await Promise.all(orders.map(async order => [order.id, await getOrderEvents(order.id)] as const));
      setEvents(Object.fromEntries(pairs));
    } catch (error) {
      Taro.showToast({ title: error?.message || '订单加载失败', icon: 'none' });
    }
  }, []);

  useSharedRefresh(load);
  useEffect(() => { load(); }, [load]);

  const resetForm = () => {
    setOrderNo(''); setSpec(''); setMaterial(''); setQty('1'); setPrice('0'); setDelivery(''); setRemark(''); setCustomer(null);
  };

  const save = async () => {
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

  const changeStatus = async (order: CustomerOrder, index: number) => {
    const next = statuses[index];
    if (next === order.status) return;
    try {
      await updateOrder(order.id, { status: next });
      Taro.showToast({ title: '状态已更新', icon: 'success' });
      await load();
    } catch (error) { Taro.showToast({ title: error?.message || '状态更新失败', icon: 'none' }); }
  };

  return <ScrollView scrollY className={styles.page} onRefresherRefresh={load} refresherEnabled>
    <View className={styles.header}><Text>客户订单</Text><View onClick={() => setShow(!show)}>{show ? '关闭' : '＋新增订单'}</View></View>
    {show && <View className={styles.form}>
      <Input placeholder="订单号" value={orderNo} onInput={e => setOrderNo(e.detail.value)} />
      <Picker range={customers.map(c => c.name)} onChange={e => setCustomer(customers[Number(e.detail.value)]?.id || null)}><View>选择客户（可选）</View></Picker>
      <Input placeholder="规格（可选，如 300×200×150mm）" value={spec} onInput={e => setSpec(e.detail.value)} />
      <Input placeholder="材质（可选，如五层AB楞）" value={material} onInput={e => setMaterial(e.detail.value)} />
      <Input type="number" placeholder="数量" value={qty} onInput={e => setQty(e.detail.value)} />
      <Input type="digit" placeholder="单价" value={price} onInput={e => setPrice(e.detail.value)} />
      <Picker mode="date" value={delivery || undefined} onChange={e => setDelivery(e.detail.value)}><View>交货日期：{delivery || '未设置'}</View></Picker>
      <Input placeholder="备注（可选）" value={remark} onInput={e => setRemark(e.detail.value)} />
      <View className={styles.save} onClick={save}>{saving ? '保存中…' : '保存订单'}</View>
    </View>}
    {list.length === 0 ? <View className={styles.empty}>暂无订单</View> : list.map(order => {
      const history = events[order.id] || [];
      return <View className={styles.item} key={order.id}>
        <View className={styles.itemMain}>
          <Text className={styles.order}>{order.order_no} · {order.customer_name || '未关联客户'}</Text>
          <Text>规格：{order.specification || '未填写'} · 材质：{order.material || '未填写'}</Text>
          <Text>数量 {order.quantity}{order.unit} · 单价 ¥{Number(order.unit_price || 0).toFixed(2)} · 金额 ¥{Number(order.amount || 0).toFixed(2)}</Text>
          <Text>交期：{order.delivery_date || '未定'}{order.remark ? ` · ${order.remark}` : ''}</Text>
          {history.length > 0 && <View className={styles.events}><Text className={styles.eventsTitle}>状态记录</Text>{history.map(event => <Text key={event.id}>{event.from} → {event.to} · {new Date(event.created_at).toLocaleString()}</Text>)}</View>}
        </View>
        <Picker range={statuses} value={Math.max(0, statuses.indexOf(order.status))} onChange={e => changeStatus(order, Number(e.detail.value))}><Text className={styles.status}>{order.status}</Text></Picker>
      </View>;
    })}
  </ScrollView>;
}
