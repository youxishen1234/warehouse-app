import React, { useState, useEffect, useCallback } from 'react';
import { View, Text, Input, ScrollView } from '@tarojs/components';
import Taro from '@tarojs/taro';
import { getProducts } from '@/services/api';
import { formatMoney, getStockStatus } from '@/utils/format';
import type { Product } from '@/types';
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

  const load = useCallback(async () => {
    try {
      const data = await getProducts(keyword || undefined);
      setList(data);
    } catch (e) { console.error('[Inventory] load failed', e); }
  }, [keyword]);

  useEffect(() => { load(); }, [load]);

  return (
    <ScrollView scrollY className={styles.container} onRefresherRefresh={load} refresherEnabled refresherTriggered={false}>
      <View className={styles.searchBox}>
        <Input className={styles.searchInput} placeholder="搜索名称或分类" value={keyword} onInput={e => setKeyword(e.detail.value)} />
      </View>

      {list.length === 0 ? (
        <View className={styles.empty}>暂无数据</View>
      ) : (
        list.map(p => {
          const status = getStockStatus(p.stock, p.safety_stock);
          return (
            <View key={p.id} className={styles.listItem}>
              <View className={styles.itemTop}>
                <Text className={styles.itemName}>{p.name}</Text>
                <Text className={styles.tag} style={{ background: status.color + '22', color: status.color }}>{status.label}</Text>
              </View>
              <View className={styles.itemBottom}>
                <View>
                  <Text className={styles.itemMeta}>{p.category || '未分类'} · {formatMoney(p.price)}</Text>
                </View>
                <Text className={styles.itemStock}>{p.stock}<Text style={{ fontSize: '24rpx', fontWeight: 'normal', color: '#9ca3af' }}>{p.unit}</Text></Text>
              </View>
              <View className={styles.itemActions}>
                <View className={styles.btnOut} onClick={() => goTransit(p, '/pages/outbound/index')}>出库</View>
                <View className={styles.btnIn} onClick={() => goTransit(p, '/pages/inbound/index')}>入库</View>
              </View>
            </View>
          );
        })
      )}
    </ScrollView>
  );
};

export default InventoryPage;
