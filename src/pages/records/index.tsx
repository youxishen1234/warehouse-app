import React, { useState, useEffect, useCallback } from 'react';
import { View, Text, Input, ScrollView, Picker } from '@tarojs/components';
import Taro, { useRouter } from '@tarojs/taro';
import { getTransactions, getProducts, deleteTransaction } from '@/services/api';
import { formatShortTime } from '@/utils/format';
import type { Transaction, Product } from '@/types';
import styles from './index.module.scss';

const RecordsPage: React.FC = () => {
  const router = useRouter();
  // 从客户管理页跳转时携带客户筛选
  const filterCustomerId = router.params.customer_id ? Number(router.params.customer_id) : null;
  const filterCustomerName = router.params.customer_name ? decodeURIComponent(router.params.customer_name) : '';

  const [list, setList] = useState<Transaction[]>([]);
  const [products, setProducts] = useState<Product[]>([]);
  const [type, setType] = useState('');
  const [keyword, setKeyword] = useState('');
  const [typeIndex, setTypeIndex] = useState(0);

  const types = ['全部', '入库', '出库'];

  const load = useCallback(async () => {
    try {
      const [tx, prods] = await Promise.all([
        getTransactions({
          type: type || undefined,
          keyword: keyword || undefined,
          customer_id: filterCustomerId || undefined
        }),
        getProducts()
      ]);
      setList(tx);
      setProducts(prods);
    } catch (e) { console.error('[Records] load failed', e); }
  }, [type, keyword, filterCustomerId]);

  useEffect(() => { load(); }, [load]);

  const productName = (id: number) => products.find(p => p.id === id)?.name || '(已删除)';

  const handleDelete = async (tx: Transaction) => {
    const product = productName(tx.product_id);
    const result = await Taro.showModal({ title: '删除记录', content: `确定删除${tx.type === 'in' ? '入库' : '出库'}记录「${product} × ${tx.quantity}」？库存将自动回滚。`, confirmColor: '#dc2626' });
    if (!result.confirm) return;
    try {
      await deleteTransaction(tx.id);
      Taro.showToast({ title: '删除成功', icon: 'success' });
      load();
    } catch (e) { console.error('[Records] delete failed', e); }
  };

  return (
    <ScrollView scrollY className={styles.container} onRefresherRefresh={load} refresherEnabled refresherTriggered={false}>
      <View className={styles.filterBox}>
        <Picker mode="selector" range={types} value={typeIndex} onChange={e => {
          const idx = Number(e.detail.value);
          setTypeIndex(idx);
          setType(idx === 0 ? '' : idx === 1 ? 'in' : 'out');
        }}>
          <View className={styles.filterSelect}>{types[typeIndex]}</View>
        </Picker>
        <Input className={styles.searchInput} placeholder="搜索商品名 / 客户名" value={keyword} onInput={e => setKeyword(e.detail.value)} />
      </View>

      {filterCustomerId && (
        <View className={styles.customerFilterBar}>
          <Text className={styles.customerFilterText}>当前客户：{filterCustomerName || `#${filterCustomerId}`}</Text>
          <Text
            className={styles.customerFilterClear}
            onClick={() => Taro.redirectTo({ url: '/pages/records/index' })}
          >
            清除筛选 ✕
          </Text>
        </View>
      )}

      {list.length === 0 ? (
        <View className={styles.empty}>暂无记录</View>
      ) : (
        list.map(t => (
          <View key={t.id} className={styles.listItem}>
            <View className={styles.itemTop}>
              <Text className={styles.itemName}>{productName(t.product_id)}</Text>
              {t.type === 'in'
                ? <Text className={styles.tagIn}>入库</Text>
                : <Text className={styles.tagOut}>出库</Text>}
            </View>
            {t.customer_name && (
              <View className={styles.customerLine}>
                <Text className={styles.customerTag}>客户</Text>
                <Text className={styles.customerName}>{t.customer_name}</Text>
              </View>
            )}
            <View className={styles.itemBottom}>
              <Text className={styles.itemMeta}>{formatShortTime(t.created_at)} {t.operator ? `· ${t.operator}` : ''}{t.remark ? ` · ${t.remark}` : ''}</Text>
              <View className={styles.itemActions}>
                <Text className={styles.itemQty} style={{ color: t.type === 'in' ? '#16a34a' : '#dc2626' }}>
                  {t.type === 'in' ? '+' : '-'}{t.quantity}
                </Text>
                <Text className={styles.deleteBtn} onClick={() => handleDelete(t)}>删除</Text>
              </View>
            </View>
          </View>
        ))
      )}
    </ScrollView>
  );
};

export default RecordsPage;
