import { useSharedRefresh } from '@/services/shared-refresh';
import React, { useState, useEffect, useCallback, useMemo, useRef } from 'react';
import { View, Text, Input, ScrollView } from '@tarojs/components';
import Taro, { useDidShow } from '@tarojs/taro';
import { getCustomers, deleteCustomer, getTransactions, getSuppliers, deleteSupplier, settleCustomer, settleSupplier } from '@/services/api';
import type { Customer, Transaction } from '@/types';
import Icon from '@/components/Icon';
import SwipeRow from '@/components/SwipeRow';
import { numberValue } from '@/utils/stock-math';
import { formatMoney, formatMoneyInput } from '@/utils/format';
import styles from './index.module.scss';

// 跨页联动中转键：tabBar 页（入库/出库）无法通过 URL 传参，用 storage 中转
const TRANSIT_KEY = 'sg_transit';


// 跳出库页并自动带出该客户（作为销售对象）
const goOutbound = (c: Customer) => {
  Taro.setStorageSync(TRANSIT_KEY, { customer_id: c.id, customer_name: c.name });
  Taro.switchTab({ url: '/pages/outbound/index' });
};

type CustomerStats = { outQty: number; inQty: number; count: number };
const EMPTY_PARTY_STATS: CustomerStats = { outQty: 0, inQty: 0, count: 0 };

type CustomerListRowProps = {
  party: Customer;
  stats: CustomerStats;
  supplier: boolean;
  open: boolean;
  onOpenChange: (id: number, open: boolean) => void;
  handleRecords: (party: Customer) => void;
  handleEdit: (id: number) => void;
  handleDelete: (party: Customer) => void;
  openSettlement: (party: Customer) => void;
};

// Keep customer and supplier rows isolated from settlement modal input state.
const CustomerListRow = React.memo(function CustomerListRow({ party, stats, supplier, open, onOpenChange, handleRecords, handleEdit, handleDelete, openSettlement }: CustomerListRowProps) {
  return <SwipeRow
    open={open}
    onOpenChange={nextOpen => onOpenChange(party.id, nextOpen)}
    onTap={() => handleRecords(party)}
    actions={[
      { text: '记录', bg: '#64748b', onClick: () => handleRecords(party) },
      { text: '编辑', bg: '#2f6bff', onClick: () => handleEdit(party.id) },
      { text: '停用', bg: '#dc2626', onClick: () => handleDelete(party) }
    ]}
  >
    <View className={styles.listItem}>
      <View className={styles.itemTop}>
        <Text className={styles.itemName}>{party.name}</Text>
        <Text className={styles.itemBadge}>{stats.count} 笔</Text>
      </View>
      <View className={styles.itemMeta}>
        {party.contact ? `联系人：${party.contact}` : '无联系方式'}
        {party.phone ? ` · 电话：${party.phone}` : ''}
        {party.address ? `\n地址：${party.address}` : ''}
        {party.remark ? `\n备注：${party.remark}` : ''}
      </View>
      <View className={styles.itemStats}>
        <Text className={styles.statItem}>{supplier ? '应付' : '应收'} {formatMoney(Number(supplier ? party.payable || 0 : party.debt || 0))}</Text>
        <Text className={styles.statItem}>出库<Text className={`${styles.statNum} ${styles.statNumOut}`}>{stats.outQty}</Text></Text>
        <Text className={styles.statItem}>入库<Text className={`${styles.statNum} ${styles.statNumIn}`}>{stats.inQty}</Text></Text>
      </View>
      <View className={styles.itemActions}>
        <View className={styles.btnOut} onClick={event => { event.stopPropagation(); openSettlement(party); }}>结算</View>
        <View className={styles.btnIn} onClick={event => { event.stopPropagation(); handleEdit(party.id); }}>编辑</View>
        {!supplier && <View className={styles.btnOut} onClick={event => { event.stopPropagation(); goOutbound(party); }}>出库</View>}
        {supplier && <View className={styles.btnIn} onClick={event => { event.stopPropagation(); Taro.setStorageSync(TRANSIT_KEY, { supplier_id: party.id, supplier_name: party.name }); Taro.switchTab({ url: '/pages/inbound/index' }); }}>入库</View>}
      </View>
    </View>
  </SwipeRow>;
});

const CustomersPage: React.FC<{ supplier?: boolean }> = ({ supplier = false }) => {
  const label = supplier ? '供应商' : '客户';
  const [list, setList] = useState<Customer[]>([]);
  const [txList, setTxList] = useState<Transaction[]>([]);
  const [loading, setLoading] = useState(true);
  const [loadError, setLoadError] = useState('');
  // 当前左滑展开的行（一次只开一行）
  const [activeId, setActiveId] = useState<number | null>(null);
  const handleActiveChange = useCallback((id: number, open: boolean) => { setActiveId(open ? id : null); }, []);
  const [settling, setSettling] = useState<{ party: Customer; balance: number } | null>(null);
  const [settleAmount, setSettleAmount] = useState('');
  const [settleRemark, setSettleRemark] = useState('');
  const settleSaving = useRef(false);
  const loadSequence = useRef(0);
  const lastLoadAt = useRef(0);

  const load = useCallback(async (forceOrRevision: boolean | string = false) => {
    const startedAt = Date.now();
    const force = forceOrRevision === true || typeof forceOrRevision === 'string';
    if (!force && startedAt - lastLoadAt.current < 250) return;
    lastLoadAt.current = startedAt;
    const sequence = ++loadSequence.current;
    setLoading(true);
    setLoadError('');
    try {
      const [customers, txs] = await Promise.all([
        supplier ? getSuppliers() : getCustomers(),
        getTransactions()
      ]);
      if (sequence !== loadSequence.current) return;
      setList(customers);
      setTxList(txs);
    } catch (error) {
      if (sequence === loadSequence.current) setLoadError(error instanceof Error ? error.message : `${label}加载失败，请点击重试`);
    } finally {
      if (sequence === loadSequence.current) setLoading(false);
    }
  }, [label, supplier]);

  useSharedRefresh(load);
  useEffect(() => { load(); }, [load]);
  useEffect(() => () => { loadSequence.current += 1; }, []);
  useDidShow(() => { load(true); });

  // 该客户的出入库统计（入库=进货额参考，出库=销售给该客户）
  const statsByParty = useMemo(() => {
    const map = new Map<number, { outQty: number; inQty: number; count: number }>();
    txList.forEach(transaction => {
      const id = supplier ? transaction.supplier_id : transaction.customer_id;
      if (id == null) return;
      const current = map.get(id) || { outQty: 0, inQty: 0, count: 0 };
      current.count += 1;
      if (transaction.type === 'out') current.outQty += transaction.quantity;
      if (transaction.type === 'in') current.inQty += transaction.quantity;
      map.set(id, current);
    });
    return map;
  }, [txList, supplier]);

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

  const handleEdit = useCallback((id: number) => {
    Taro.navigateTo({ url: `/pages/customer-edit/index?id=${id}&party=${supplier ? 'supplier' : 'customer'}` });
  }, [supplier]);

  const handleRecords = useCallback((c: Customer) => {
    // 跳出入库记录页并带上客户筛选（记录页读取 customer_id 参数）
    Taro.navigateTo({ url: `/pages/records/index?${supplier ? 'supplier_id' : 'customer_id'}=${c.id}&customer_name=${encodeURIComponent(c.name)}` });
  }, [supplier]);

  const openSettlement = useCallback((party: Customer) => {
    const balance = Number(supplier ? party.payable || 0 : party.debt || 0);
    if (!(balance > 0) || settleSaving.current) return;
    setSettling({ party, balance });
    setSettleAmount(formatMoneyInput(balance));
    setSettleRemark('');
  }, [supplier]);

  const submitSettlement = async () => {
    if (!settling || settleSaving.current) return;
    let amount: number;
    try { amount = numberValue(settleAmount, '结算金额', true); }
    catch (error) { Taro.showToast({ title: error instanceof Error ? error.message : '请输入有效结算金额', icon: 'none' }); return; }
    if (amount > settling.balance) { Taro.showToast({ title: '结算金额不能超过当前余额', icon: 'none' }); return; }
    settleSaving.current = true;
    try {
      // 提交本次结算金额，由服务端基于当前余额原子扣减，避免多设备并发时记错金额。
      const result = supplier
        ? await settleSupplier(settling.party.id, amount, settleRemark.trim())
        : await settleCustomer(settling.party.id, amount, settleRemark.trim());
      const balance = Number(result?.balance ?? 0);
      setSettling(null); setSettleAmount(''); setSettleRemark('');
      Taro.showToast({ title: balance === 0 ? '已全部结清' : '部分结算成功', icon: 'success' });
      await load();
    } catch (error) { Taro.showToast({ title: error?.message || '结算失败', icon: 'none' }); }
    finally { settleSaving.current = false; }
  };

  const handleDelete = useCallback(async (c: Customer) => {
    const res = await Taro.showModal({
      title: '停用确认',
      content: `确定停用${label}「${c.name}」？历史流水会保留。`,
      confirmColor: '#dc2626'
    });
    if (res.confirm) {
      try {
        await (supplier ? deleteSupplier(c.id) : deleteCustomer(c.id));
        Taro.showToast({ title: '删除成功', icon: 'success' });
        load();
      } catch (e) { console.error('[Customers] delete failed', e); }
    }
  }, [label, supplier, load]);

  return (
    <ScrollView scrollY className={styles.container} onRefresherRefresh={() => load(true)} refresherEnabled refresherTriggered={false}>
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

      {loading ? (
        <View className={styles.empty}>正在加载{label}资料…</View>
      ) : loadError ? (
        <View className={styles.empty} onClick={() => load(true)}>{loadError} · 点击重试</View>
      ) : list.length === 0 ? (
        <View className={styles.empty}>暂无{label}</View>
      ) : (
        list.map(party => <CustomerListRow
          key={party.id}
          party={party}
          stats={statsByParty.get(party.id) || EMPTY_PARTY_STATS}
          supplier={supplier}
          open={activeId === party.id}
          onOpenChange={handleActiveChange}
          handleRecords={handleRecords}
          handleEdit={handleEdit}
          handleDelete={handleDelete}
          openSettlement={openSettlement}
        />)
      )}
      {settling && <View className={styles.settleMask} onClick={() => { if (!settleSaving.current) setSettling(null); }}><View className={styles.settleDialog} onClick={e => e.stopPropagation()}><Text className={styles.settleTitle}>{supplier ? '供应商结算' : '客户结算'} · {settling.party.name}</Text><Text className={styles.settleHint}>当前余额 {formatMoney(settling.balance)}，支持部分结算</Text><Input className={styles.settleInput} type="digit" value={settleAmount} placeholder="结算金额" onInput={e => setSettleAmount(e.detail.value)} disabled={settleSaving.current} /><Input className={styles.settleInput} value={settleRemark} placeholder="结算备注（可选）" onInput={e => setSettleRemark(e.detail.value)} disabled={settleSaving.current} /><View className={styles.settleActions}><View className={styles.settleCancel} onClick={() => { if (!settleSaving.current) setSettling(null); }}>取消</View><View className={styles.settleConfirm} onClick={submitSettlement}>{settleSaving.current ? '保存中…' : '确认结算'}</View></View></View></View>}
    </ScrollView>
  );
};

export default CustomersPage;
