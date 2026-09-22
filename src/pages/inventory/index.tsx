import { useSharedRefresh } from '@/services/shared-refresh';
import React, { useState, useEffect, useCallback } from 'react';
import { View, Text, Input, ScrollView, Picker } from '@tarojs/components';
import Taro from '@tarojs/taro';
import { getProducts, addStocktake, getStocktakes } from '@/services/api';
import { formatMoney, getStockStatus } from '@/utils/format';
import type { Product, Stocktake } from '@/types';
import styles from './index.module.scss';

// 跨页联动中转键：tabBar 页（入库/出库）无法通过 URL 传参，用 storage 中转
const TRANSIT_KEY = 'sg_transit';

// 跳入库/出库页并自动选中该商品
const goTransit = (p: Product, url: string) => {
  Taro.setStorageSync(TRANSIT_KEY, { product_id: p.id, product_name: p.name });
  Taro.switchTab({ url });
};

const InventoryPage: React.FC = () => {
  const [list, setList] = useState<Product[]>([]);
  const [counting, setCounting] = useState<Product | null>(null);
  const [countValue, setCountValue] = useState('');
  const [countRemark, setCountRemark] = useState('');
  const [countDate, setCountDate] = useState(() => new Date().toISOString().slice(0, 10));
  const [takes, setTakes] = useState<Stocktake[]>([]);
  const submitCount = async () => {
    if (!counting) return;
    const count = Number(countValue);
    if (!Number.isFinite(count) || count < 0) { Taro.showToast({ title: '请输入有效库存数量', icon: 'none' }); return; }
    try { await addStocktake({ product_id: counting.id, counted_stock: count, counted_at: countDate, remark: countRemark || '库存盘点' }); Taro.showToast({ title: '盘点已保存', icon: 'success' }); setCounting(null); setCountValue(''); setCountRemark(''); setCountDate(new Date().toISOString().slice(0, 10)); load(); }
    catch (e) { Taro.showToast({ title: e?.message || '盘点失败', icon: 'none' }); }
  };

  const load = useCallback(async () => {
    try {
      const [data, history] = await Promise.all([getProducts(), getStocktakes()]);
      setList(data); setTakes(history);
    } catch (e) { console.error('[Inventory] load failed', e); }
  }, []);

  useSharedRefresh(load);
  useEffect(() => { load(); }, [load]);

  return (
    <ScrollView scrollY className={styles.container} onRefresherRefresh={load} refresherEnabled refresherTriggered={false}>
      {list.length === 0 ? (
        <View className={styles.empty}>暂无数据</View>
      ) : (
        list.map(p => {
          const status = getStockStatus(p.stock, p.safety_stock);
          const latest = takes.find(t => t.product_id === p.id);
          return (
            <View key={p.id} className={styles.listItem}>
              <View className={styles.itemTop}>
                <Text className={styles.itemName}>{p.name}</Text>
                <Text className={styles.tag} style={{ background: status.color + '22', color: status.color }}>{status.label}</Text>
              </View>
              <View className={styles.itemBottom}>
                <View>
                  <Text className={styles.itemMeta}>{p.category || '未分类'} · {p.specification || '无规格'} · {p.material || '无材质'} · {formatMoney(p.price)}</Text>
                </View>
                <Text className={styles.itemStock}>{p.stock}<Text style={{ fontSize: '24rpx', fontWeight: 'normal', color: '#9ca3af' }}>{p.unit}</Text></Text>
              </View>
              {latest && <Text className={styles.itemMeta}>上次盘点：{new Date(latest.counted_at || latest.created_at).toLocaleDateString()} · {latest.diff > 0 ? `盘盈 ${latest.diff}` : latest.diff < 0 ? `盘亏 ${Math.abs(latest.diff)}` : '无差异'}</Text>}
              <View className={styles.itemActions}>
                <View className={styles.btnIn} onClick={() => { setCounting(p); setCountValue(String(p.stock)); }}>盘点</View>
                <View className={styles.btnOut} onClick={() => goTransit(p, '/pages/outbound/index')}>出库</View>
                <View className={styles.btnIn} onClick={() => goTransit(p, '/pages/inbound/index')}>入库</View>
              </View>
            </View>
          );
        })
      )}
      {counting && <View className={styles.modalMask}><View className={styles.countModal}><Text className={styles.modalTitle}>库存盘点 · {counting.name}</Text><Text className={styles.modalHint}>当前库存 {counting.stock}{counting.unit}</Text><Picker mode="date" value={countDate} onChange={e => setCountDate(e.detail.value)}><View className={styles.datePicker}>盘点日期：{countDate}</View></Picker><Input className={styles.modalInput} type="digit" placeholder="盘点后数量" value={countValue} onInput={e=>setCountValue(e.detail.value)} /><Input className={styles.modalInput} placeholder="盘点说明（可选）" value={countRemark} onInput={e=>setCountRemark(e.detail.value)} /><View className={styles.modalActions}><View onClick={()=>setCounting(null)}>取消</View><View onClick={submitCount}>保存盘点</View></View></View></View>}
    </ScrollView>
  );
};

export default InventoryPage;
