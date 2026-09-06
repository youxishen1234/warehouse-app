import React, { useState, useEffect, useCallback } from 'react';
import { View, Text, Input, ScrollView } from '@tarojs/components';
import Taro from '@tarojs/taro';
import { getProducts, deleteProduct } from '@/services/api';
import { formatMoney } from '@/utils/format';
import type { Product } from '@/types';
import SwipeRow from '@/components/SwipeRow';
import styles from './index.module.scss';

// 跨页联动中转键：tabBar 页（入库/出库）无法通过 URL 传参，用 storage 中转
const TRANSIT_KEY = 'sg_transit';

// 跳入库页并自动选中该商品
const goInbound = (p: Product) => {
  Taro.setStorageSync(TRANSIT_KEY, { product_id: p.id, product_name: p.name });
  Taro.switchTab({ url: '/pages/inbound/index' });
};

// 跳出库页并自动选中该商品
const goOutbound = (p: Product) => {
  Taro.setStorageSync(TRANSIT_KEY, { product_id: p.id, product_name: p.name });
  Taro.switchTab({ url: '/pages/outbound/index' });
};

const ProductsPage: React.FC = () => {
  const [list, setList] = useState<Product[]>([]);
  const [keyword, setKeyword] = useState('');
  // 当前左滑展开的行（一次只开一行）
  const [activeId, setActiveId] = useState<number | null>(null);

  const load = useCallback(async () => {
    try {
      const data = await getProducts(keyword || undefined);
      setList(data);
    } catch (e) { console.error('[Products] load failed', e); }
  }, [keyword]);

  useEffect(() => { load(); }, [load]);

  const handleAdd = () => {
    Taro.navigateTo({ url: '/pages/product-edit/index' });
  };

  const handleEdit = (id: number) => {
    Taro.navigateTo({ url: `/pages/product-edit/index?id=${id}` });
  };

  const handleDelete = async (id: number, name: string) => {
    const res = await Taro.showModal({ title: '删除确认', content: `确定删除「${name}」？相关出入库记录也将被删除。`, confirmColor: '#dc2626' });
    if (res.confirm) {
      try {
        await deleteProduct(id);
        Taro.showToast({ title: '删除成功', icon: 'success' });
        load();
      } catch (e) { console.error('[Products] delete failed', e); }
    }
  };

  return (
    <ScrollView scrollY className={styles.container} onRefresherRefresh={load} refresherEnabled refresherTriggered={false}>
      <View className={styles.searchBox}>
        <Input className={styles.searchInput} placeholder="搜索名称或分类" value={keyword} onInput={e => setKeyword(e.detail.value)} />
        <View className={styles.addBtn} onClick={handleAdd}>+ 新增</View>
      </View>

      {list.length === 0 ? (
        <View className={styles.empty}>暂无商品，点击右上角"新增"</View>
      ) : (
        list.map(p => (
          <SwipeRow
            key={p.id}
            open={activeId === p.id}
            onOpenChange={o => setActiveId(o ? p.id : null)}
            onTap={() => handleEdit(p.id)}
            actions={[
              { text: '编辑', bg: '#2f6bff', onClick: () => handleEdit(p.id) },
              { text: '删除', bg: '#dc2626', onClick: () => handleDelete(p.id, p.name) }
            ]}
          >
            <View className={styles.listItem}>
              <View className={styles.itemTop}>
                <Text className={styles.itemName}>{p.name}</Text>
              </View>
              <Text className={styles.itemMeta}>{p.category || '未分类'} · {p.unit} · {formatMoney(p.price)} · 库存 {p.stock}</Text>
              <View className={styles.itemActions}>
                <View className={styles.btnOut} onClick={e => { e.stopPropagation(); goOutbound(p); }}>出库</View>
                <View className={styles.btnIn} onClick={e => { e.stopPropagation(); goInbound(p); }}>入库</View>
              </View>
            </View>
          </SwipeRow>
        ))
      )}
    </ScrollView>
  );
};

export default ProductsPage;
