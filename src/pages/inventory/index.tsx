import { useSharedRefresh } from '@/services/shared-refresh';
import React, { useState, useEffect, useCallback, useRef } from 'react';
import { View, Text, Input, ScrollView, Picker } from '@tarojs/components';
import Taro from '@tarojs/taro';
import { getProducts, addStocktake, getStocktakes } from '@/services/api';
import { formatMoney, getStockStatus } from '@/utils/format';
import { localDate, numberValue } from '@/utils/stock-math';
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
  const [keyword, setKeyword] = useState('');
  const [counting, setCounting] = useState<Product | null>(null);
  const [countValue, setCountValue] = useState('');
  const [countRemark, setCountRemark] = useState('');
  const [countDate, setCountDate] = useState(() => localDate());
  const [takes, setTakes] = useState<Stocktake[]>([]);
  const [loading, setLoading] = useState(true);
  const [loadError, setLoadError] = useState('');
  const [countSaving, setCountSaving] = useState(false);
  const countSavingRef = useRef(false);
  const requestId = useRef(0);
  const submitCount = async () => {
    if (!counting || countSavingRef.current) return;
    let count: number;
    try { count = numberValue(countValue, '盘点数量'); }
    catch (e) { Taro.showToast({ title: e instanceof Error ? e.message : '请输入有效库存数量', icon: 'none' }); return; }
    try {
      countSavingRef.current = true;
      setCountSaving(true);
      await addStocktake({ product_id: counting.id, counted_stock: count, counted_at: countDate, remark: countRemark.trim() || '库存盘点' });
      Taro.showToast({ title: '盘点已保存', icon: 'success' }); setCounting(null); setCountValue(''); setCountRemark(''); setCountDate(localDate()); await load();
    } catch (e) { Taro.showToast({ title: e instanceof Error ? e.message : '盘点失败', icon: 'none' }); }
    finally { countSavingRef.current = false; setCountSaving(false); }
  };

  const load = useCallback(async () => {
    const current = ++requestId.current;
    setLoading(true);
    try {
      const [data, history] = await Promise.all([getProducts(), getStocktakes()]);
      if (current !== requestId.current) return;
      setList(data); setTakes(history);
      setLoadError('');
    } catch (e) { if (current === requestId.current) setLoadError(e instanceof Error ? e.message : '库存加载失败，请重试'); }
    finally { if (current === requestId.current) setLoading(false); }
  }, []);

  useSharedRefresh(load);
  useEffect(() => { load(); }, [load]);

  const normalizedKeyword = keyword.trim().toLowerCase();
  const visibleList = normalizedKeyword
    ? list.filter(product => [product.name, product.category, product.specification, product.material, product.unit]
      .filter(Boolean)
      .some(value => String(value).toLowerCase().includes(normalizedKeyword)))
    : list;

  return (
    <ScrollView scrollY className={styles.container} onRefresherRefresh={load} refresherEnabled refresherTriggered={false}>
      {!loadError && <View className={styles.searchBox}><Input className={styles.searchInput} value={keyword} placeholder="搜索商品、规格、材质或单位" onInput={event => setKeyword(event.detail.value)} /></View>}
      {loadError ? (
        <View className={styles.empty} onClick={load}>{loadError} · 点击重试</View>
      ) : loading && list.length === 0 ? (
        <View className={styles.empty}>正在加载库存…</View>
      ) : list.length === 0 ? (
        <View className={styles.empty}>暂无库存商品</View>
      ) : visibleList.length === 0 ? (
        <View className={styles.empty}>没有匹配的库存商品</View>
      ) : (
        visibleList.map(p => {
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
                <View className={styles.btnEdit} onClick={() => { if (!countSaving) { setCounting(p); setCountValue(String(p.stock)); setCountRemark(''); setCountDate(localDate()); } }}>编辑库存</View>
                <View className={styles.btnOut} onClick={() => goTransit(p, '/pages/outbound/index')}>出库</View>
                <View className={styles.btnIn} onClick={() => goTransit(p, '/pages/inbound/index')}>入库</View>
              </View>
            </View>
          );
        })
      )}
      {counting && <View className={styles.modalMask}><View className={styles.countModal}><Text className={styles.modalTitle}>编辑库存 · {counting.name}</Text><Text className={styles.modalHint}>当前库存 {counting.stock}{counting.unit}，保存后会生成盘点调整记录</Text><Picker disabled={countSaving} mode="date" value={countDate} onChange={e => setCountDate(e.detail.value)}><View className={styles.datePicker}>调整日期：{countDate}</View></Picker><Input disabled={countSaving} className={styles.modalInput} type="digit" placeholder="输入新的库存数量" value={countValue} onInput={e=>setCountValue(e.detail.value)} /><Input disabled={countSaving} className={styles.modalInput} placeholder="调整说明（可选）" value={countRemark} onInput={e=>setCountRemark(e.detail.value)} /><View className={styles.modalActions}><View onClick={()=>{ if (!countSaving) setCounting(null); }}>取消</View><View className={countSaving ? styles.disabled : ''} onClick={submitCount}>{countSaving ? '保存中…' : '保存库存'}</View></View></View></View>}
    </ScrollView>
  );
};

export default InventoryPage;
