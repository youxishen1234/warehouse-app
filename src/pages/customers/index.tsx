import { useSharedRefresh } from '@/services/shared-refresh';
import React, { useState, useEffect, useCallback } from 'react';
import { View, Text, Input, ScrollView } from '@tarojs/components';
import Taro, { useDidShow } from '@tarojs/taro';
import { getCustomers, deleteCustomer, getTransactions, getSuppliers, deleteSupplier, updateCustomer, updateSupplier } from '@/services/api';
import type { Customer, Transaction } from '@/types';
import Icon from '@/components/Icon';
import SwipeRow from '@/components/SwipeRow';
import styles from './index.module.scss';

// 跨页联动中转键：tabBar 页（入库/出库）无法通过 URL 传参，用 storage 中转
const TRANSIT_KEY = 'sg_transit';

// 跳入库页并自动带出该客户（作为供应商/关联客户）
const goInbound = (c: Customer) => {
  Taro.setStorageSync(TRANSIT_KEY, { customer_id: c.id, customer_name: c.name });
  Taro.switchTab({ url: '/pages/inbound/index' });
};

// 跳出库页并自动带出该客户（作为销售对象）
const goOutbound = (c: Customer) => {
  Taro.setStorageSync(TRANSIT_KEY, { customer_id: c.id, customer_name: c.name });
  Taro.switchTab({ url: '/pages/outbound/index' });
};

const CustomersPage: React.FC<{ supplier?: boolean }> = ({ supplier = false }) => {
  const label = supplier ? '供应商' : '客户';
  const [list, setList] = useState<Customer[]>([]);
  const [txList, setTxList] = useState<Transaction[]>([]);
  // 当前左滑展开的行（一次只开一行）
  const [activeId, setActiveId] = useState<number | null>(null);

  const load = useCallback(async () => {
    try {
      const [customers, txs] = await Promise.all([
        supplier ? getSuppliers() : getCustomers(),
        getTransactions()
      ]);
      setList(customers);
      setTxList(txs);
    } catch (e) { console.error('[Customers] load failed', e); }
  }, [supplier]);

  useSharedRefresh(load);
  useEffect(() => { load(); }, [load]);
  useDidShow(() => { load(); });

  // 该客户的出入库统计（入库=进货额参考，出库=销售给该客户）
  const statsOf = (id: number) => {
    const mine = txList.filter(t => t.customer_id === id);
    return {
      outQty: mine.filter(t => t.type === 'out').reduce((s, t) => s + t.quantity, 0),
      inQty: mine.filter(t => t.type === 'in').reduce((s, t) => s + t.quantity, 0),
      count: mine.length
    };
  };

  const handleAdd = () => {
    Taro.navigateTo({ url: `/pages/customer-edit/index?party=${supplier ? 'supplier' : 'customer'}` });
  };

  const handleGoProducts = () => {
    Taro.navigateTo({ url: '/pages/products/index' });
  };

  const handleGoInventory = () => {
    Taro.navigateTo({ url: '/pages/inventory/index' });
  };

  const handleGoInbound = () => {
    Taro.switchTab({ url: '/pages/inbound/index' });
  };

  const handleGoOutbound = () => {
    Taro.switchTab({ url: '/pages/outbound/index' });
  };

  const handleEdit = (id: number) => {
    Taro.navigateTo({ url: `/pages/customer-edit/index?id=${id}&party=${supplier ? 'supplier' : 'customer'}` });
  };

  const handleRecords = (c: Customer) => {
    // 跳出入库记录页并带上客户筛选（记录页读取 customer_id 参数）
    Taro.navigateTo({ url: `/pages/records/index?${supplier ? 'supplier_id' : 'customer_id'}=${c.id}&customer_name=${encodeURIComponent(c.name)}` });
  };

  const handleDelete = async (c: Customer) => {
    const res = await Taro.showModal({
      title: '删除确认',
      content: `确定删除${label}「${c.name}」？`,
      confirmColor: '#dc2626'
    });
    if (res.confirm) {
      try {
        await (supplier ? deleteSupplier(c.id) : deleteCustomer(c.id));
        Taro.showToast({ title: '删除成功', icon: 'success' });
        load();
      } catch (e) { console.error('[Customers] delete failed', e); }
    }
  };

  return (
    <ScrollView scrollY className={styles.container} onRefresherRefresh={load} refresherEnabled refresherTriggered={false}>
      <View className={styles.toolbar}><View className={styles.addBtn} onClick={handleAdd}>+ 新增</View></View>

      <View className={styles.quickLinks}>
        <View className={styles.quickLink} onClick={handleGoProducts}>
          <Icon name="tag" color="#d97706" className={styles.quickLinkIcon} />
          <Text className={styles.quickLinkText}>商品</Text>
        </View>
        <View className={styles.quickLink} onClick={handleGoInventory}>
          <Icon name="clipboard" color="#7c3aed" className={styles.quickLinkIcon} />
          <Text className={styles.quickLinkText}>库存</Text>
        </View>
        <View className={styles.quickLink} onClick={handleGoInbound}>
          <Icon name="inbound" color="#16a34a" className={styles.quickLinkIcon} />
          <Text className={styles.quickLinkText}>入库</Text>
        </View>
        <View className={styles.quickLink} onClick={handleGoOutbound}>
          <Icon name="outbound" color="#2f6bff" className={styles.quickLinkIcon} />
          <Text className={styles.quickLinkText}>出库</Text>
        </View>
      </View>

      {list.length === 0 ? (
        <View className={styles.empty}>暂无{label}</View>
      ) : (
        list.map(c => {
          const s = statsOf(c.id);
          return (
            <SwipeRow
              key={c.id}
              open={activeId === c.id}
              onOpenChange={o => setActiveId(o ? c.id : null)}
              onTap={() => handleRecords(c)}
              actions={[
                { text: '流水', bg: '#64748b', onClick: () => handleRecords(c) },
                { text: '编辑', bg: '#2f6bff', onClick: () => handleEdit(c.id) },
                { text: '删除', bg: '#dc2626', onClick: () => handleDelete(c) }
              ]}
            >
              <View className={styles.listItem}>
                <View className={styles.itemTop}>
                  <Text className={styles.itemName}>{c.name}</Text>
                  <Text className={styles.itemBadge}>{s.count} 笔流水</Text>
                </View>
                <View className={styles.itemMeta}>
                  {c.contact ? `联系人：${c.contact}` : '未填联系人'}
                  {c.phone ? ` · 电话：${c.phone}` : ''}
                  {c.address ? `\n地址：${c.address}` : ''}
                  {c.remark ? `\n备注：${c.remark}` : ''}
                </View>
                <View className={styles.itemStats}>
                  <Text className={styles.statItem}>{supplier ? '应付款' : '欠款'} ¥{Number(supplier ? c.payable || 0 : c.debt || 0).toFixed(2)}</Text>
                  <Text className={styles.statItem}>出库<Text className={`${styles.statNum} ${styles.statNumOut}`}>{s.outQty}</Text></Text>
                  <Text className={styles.statItem}>入库<Text className={`${styles.statNum} ${styles.statNumIn}`}>{s.inQty}</Text></Text>
                </View>
                <View className={styles.itemActions}>
                  <View className={styles.btnOut} onClick={async e => {
                    e.stopPropagation();
                    if (!Number(supplier ? c.payable : c.debt)) return;
                    const choice = await Taro.showModal({ title: '确认结清', content: `结清「${c.name}」全部${supplier ? '应付款' : '欠款'}？` });
                    if (!choice.confirm) return;
                    try { await (supplier ? updateSupplier(c.id, { payable: 0 }) : updateCustomer(c.id, { debt: 0 })); Taro.showToast({ title: '结清成功', icon: 'success' }); await load(); } catch (error) { Taro.showToast({ title: error?.message || '结清失败', icon: 'none' }); }
                  }}>结清</View>
                  <View className={styles.btnIn} onClick={e => { e.stopPropagation(); handleEdit(c.id); }}>编辑</View>
                  {!supplier && <View className={styles.btnOut} onClick={e => { e.stopPropagation(); goOutbound(c); }}>出库</View>}
                  {supplier && <View className={styles.btnIn} onClick={e => { e.stopPropagation(); Taro.setStorageSync(TRANSIT_KEY, { supplier_id: c.id, supplier_name: c.name }); Taro.switchTab({ url: '/pages/inbound/index' }); }}>入库</View>}
                </View>
              </View>
            </SwipeRow>
          );
        })
      )}
    </ScrollView>
  );
};

export default CustomersPage;
