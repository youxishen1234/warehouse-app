import { useSharedRefresh } from '@/services/shared-refresh';
import React, { useState, useEffect, useCallback, useMemo, useRef } from 'react';
import { View, Text, Input, ScrollView, Picker } from '@tarojs/components';
import Taro from '@tarojs/taro';
import { addStocktake, getStocktakes } from '@/services/api';
import { invalidateProducts, loadProducts } from '@/services/product-store';
import { formatMoney, formatShortTime, getStockStatus } from '@/utils/format';
import { localDate, numberValue, sanitizeDecimalInput } from '@/utils/stock-math';
import type { Product, Stocktake } from '@/types';
import styles from './index.module.scss';
import { useRemoteData } from '@/hooks/useRemoteData';

// 跨页联动中转键：tabBar 页（入库/出库）无法通过 URL 传参，用 storage 中转
const TRANSIT_KEY = 'sg_transit';

// 跳入库/出库页并自动选中该商品
const goTransit = (p: Product, url: string) => {
  Taro.setStorageSync(TRANSIT_KEY, { product_id: p.id, product_name: p.name });
  Taro.switchTab({ url });
};

type InventoryListRowProps = {
  product: Product;
  latest?: Stocktake;
  onCount: (product: Product) => void;
};

// Keep the large inventory list independent from modal input state. Typing a
// count remark/date should only update the modal; unchanged rows retain their
// DOM and avoid repeating status/format calculations.
const InventoryListRow = React.memo(function InventoryListRow({ product, latest, onCount }: InventoryListRowProps) {
  const status = getStockStatus(product.stock, product.safety_stock);
  return (
    <View className={styles.listItem}>
      <View className={styles.itemTop}>
        <Text className={styles.itemName}>{product.name}</Text>
        <Text className={styles.tag} style={{ background: status.color + '22', color: status.color }}>{status.label}</Text>
      </View>
      <View className={styles.itemBottom}>
        <View>
          <Text className={styles.itemMeta}>{product.category || '未分类'} · {product.specification || '无规格'} · {product.material || '无材质'} · {formatMoney(product.price)}</Text>
        </View>
        <Text className={styles.itemStock}>{product.stock}<Text style={{ fontSize: '24rpx', fontWeight: 'normal', color: '#9ca3af' }}>{product.unit}</Text></Text>
      </View>
      {latest && <Text className={styles.itemMeta}>上次盘点：{formatShortTime(latest.counted_at || latest.created_at)} · {latest.diff > 0 ? `盘盈 ${latest.diff}` : latest.diff < 0 ? `盘亏 ${Math.abs(latest.diff)}` : '无差异'}</Text>}
      <View className={styles.itemActions}>
        <View className={styles.btnEdit} onClick={() => onCount(product)}>编辑库存</View>
        <View className={styles.btnOut} onClick={() => goTransit(product, '/pages/outbound/index')}>出库</View>
        <View className={styles.btnIn} onClick={() => goTransit(product, '/pages/inbound/index')}>入库</View>
      </View>
    </View>
  );
});

const InventoryPage: React.FC = () => {
  const [keyword, setKeyword] = useState('');
  const [filterKeyword, setFilterKeyword] = useState('');
  const [counting, setCounting] = useState<Product | null>(null);
  const [countValue, setCountValue] = useState('');
  const [countRemark, setCountRemark] = useState('');
  const [countDate, setCountDate] = useState(() => localDate());
  const [countSaving, setCountSaving] = useState(false);
  const countSavingRef = useRef(false);
  const keywordTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const openCount = useCallback((product: Product) => {
    if (countSavingRef.current) return;
    setCounting(product);
    setCountValue(String(product.stock));
    setCountRemark('');
    setCountDate(localDate());
  }, []);
  useEffect(() => () => { if (keywordTimer.current) clearTimeout(keywordTimer.current); }, []);
  const submitCount = async () => {
    if (!counting || countSavingRef.current) return;
    let count: number;
    try { count = numberValue(countValue, '盘点数量'); }
    catch (e) { Taro.showToast({ title: e instanceof Error ? e.message : '请输入有效库存数量', icon: 'none' }); return; }
    try {
      countSavingRef.current = true;
      setCountSaving(true);
      await addStocktake({ product_id: counting.id, counted_stock: count, counted_at: countDate, remark: countRemark.trim() || '库存盘点' });
      invalidateProducts();
      Taro.showToast({ title: '盘点已保存', icon: 'success' }); setCounting(null); setCountValue(''); setCountRemark(''); setCountDate(localDate()); await load();
    } catch (e) { Taro.showToast({ title: e instanceof Error ? e.message : '盘点失败', icon: 'none' }); }
    finally { countSavingRef.current = false; setCountSaving(false); }
  };

  const loadInventory = useCallback(async () => {
    const [list, takes] = await Promise.all([loadProducts(true), getStocktakes()]);
    return { list, takes };
  }, []);
  const remote = useRemoteData(loadInventory, { list: [] as Product[], takes: [] as Stocktake[] });
  const list = remote.data.list;
  const takes = remote.data.takes;
  const loading = remote.loading;
  const loadError = remote.loadError;
  const load = remote.reload;

  useSharedRefresh(load);

  const normalizedKeyword = filterKeyword.trim().toLowerCase();
  const visibleList = useMemo(() => normalizedKeyword
    ? list.filter(product => [product.name, product.category, product.specification, product.material, product.unit]
      .filter(Boolean)
      .some(value => String(value).toLowerCase().includes(normalizedKeyword)))
    : list, [list, normalizedKeyword]);
  const latestByProduct = useMemo(() => new Map(takes.map(take => [take.product_id, take])), [takes]);

  return (
    <ScrollView scrollY className={styles.container} onRefresherRefresh={load} refresherEnabled refresherTriggered={false}>
      {!loadError && <View className={styles.searchBox}><Input className={styles.searchInput} value={keyword} placeholder="搜索商品、规格、材质或单位" onInput={event => { const next = event.detail.value; setKeyword(next); if (keywordTimer.current) clearTimeout(keywordTimer.current); keywordTimer.current = setTimeout(() => setFilterKeyword(next), 300); }} /></View>}
      {loadError ? (
        <View className={styles.empty} onClick={load}>{loadError} · 点击重试</View>
      ) : loading && list.length === 0 ? (
        <View className={styles.empty}>正在加载库存…</View>
      ) : list.length === 0 ? (
        <View className={styles.empty}>暂无库存商品</View>
      ) : visibleList.length === 0 ? (
        <View className={styles.empty}>没有匹配的库存商品</View>
      ) : (
        visibleList.map(product => <InventoryListRow
          key={product.id}
          product={product}
          latest={latestByProduct.get(product.id)}
          onCount={openCount}
        />)
      )}
      {counting && <View className={styles.modalMask}><View className={styles.countModal}><Text className={styles.modalTitle}>编辑库存 · {counting.name}</Text><Text className={styles.modalHint}>当前库存 {counting.stock}{counting.unit}，保存后会生成盘点调整记录</Text><Picker disabled={countSaving} mode="date" value={countDate} onChange={e => setCountDate(e.detail.value)}><View className={styles.datePicker}>调整日期：{countDate}</View></Picker><Input disabled={countSaving} className={styles.modalInput} type="digit" placeholder="输入新的库存数量" value={countValue} onInput={e=>setCountValue(sanitizeDecimalInput(e.detail.value, 6))} /><Input disabled={countSaving} className={styles.modalInput} placeholder="调整说明（可选）" value={countRemark} onInput={e=>setCountRemark(e.detail.value)} /><View className={styles.modalActions}><View onClick={()=>{ if (!countSaving) setCounting(null); }}>取消</View><View className={countSaving ? styles.disabled : ''} onClick={submitCount}>{countSaving ? '保存中…' : '保存库存'}</View></View></View></View>}
    </ScrollView>
  );
};

export default InventoryPage;
