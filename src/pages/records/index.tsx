import { useSharedRefresh } from '@/services/shared-refresh';
import React, { useState, useEffect, useCallback } from 'react';
import { View, Text, ScrollView, Picker, Switch } from '@tarojs/components';
import Taro, { useRouter } from '@tarojs/taro';
import { getTransactions, getProducts } from '@/services/api';
import { downloadCsv } from '@/services/download';
import { formatShortTime } from '@/utils/format';
import type { Transaction, Product } from '@/types';
import styles from './index.module.scss';

const RecordsPage: React.FC = () => {
  const router = useRouter();
  // 从客户管理页跳转时携带客户筛选
  const filterCustomerId = router.params.customer_id ? Number(router.params.customer_id) : null;
  const filterSupplierId = router.params.supplier_id ? Number(router.params.supplier_id) : null;
  const filterCustomerName = router.params.customer_name ? decodeURIComponent(router.params.customer_name) : '';

  const [list, setList] = useState<Transaction[]>([]);
  const [products, setProducts] = useState<Product[]>([]);
  const [type, setType] = useState('');
  const [typeIndex, setTypeIndex] = useState(0);
  const [fromDate, setFromDate] = useState('');
  const [toDate, setToDate] = useState('');
  const [includeVoided, setIncludeVoided] = useState(false);

  const types = ['全部', '入库', '出库'];

  const load = useCallback(async () => {
    if (fromDate && toDate && fromDate > toDate) {
      Taro.showToast({ title: '开始日期不能晚于结束日期', icon: 'none' });
      setList([]);
      return;
    }
    try {
      const [tx, prods] = await Promise.all([
        getTransactions({
          type: type || undefined,
          include_voided: includeVoided,
          customer_id: filterCustomerId || undefined,
          supplier_id: filterSupplierId || undefined
          , from: fromDate ? new Date(`${fromDate}T00:00:00`).getTime() : undefined
          , to: toDate ? new Date(`${toDate}T00:00:00`).getTime() : undefined
        }),
        getProducts()
      ]);
      setList(tx);
      setProducts(prods);
    } catch (e) { console.error('[Records] load failed', e); }
  }, [type, filterCustomerId, filterSupplierId, fromDate, toDate, includeVoided]);

  useSharedRefresh(load);
  useEffect(() => { load(); }, [load]);

  const productName = (id: number, fallback?: string) => fallback || products.find(p => p.id === id)?.name || '(已停用商品)';
  const exportCsv = async () => {
    try {
      if (fromDate && toDate && fromDate > toDate) throw new Error('开始日期不能晚于结束日期');
      const filters = { type, customer_id: filterCustomerId, supplier_id: filterSupplierId, include_voided: includeVoided, from: fromDate ? new Date(`${fromDate}T00:00:00`).getTime() : '', to: toDate ? new Date(`${toDate}T00:00:00`).getTime() : '' };
      const query = Object.entries(filters).filter(([, value]) => value !== '' && value !== null).map(([key, value]) => `${key}=${encodeURIComponent(String(value))}`).join('&');
      await downloadCsv(`/api/export/transactions.csv?${query}`, 'stock-records.csv');
    } catch (error) { Taro.showToast({ title: error?.message || '导出失败', icon: 'none' }); }
  };

  return (
    <ScrollView scrollY className={styles.container} onRefresherRefresh={load} refresherEnabled refresherTriggered={false}>
      <View className={styles.filterBox}>
        <View className={styles.exportBtn} onClick={exportCsv}>导出 CSV</View>
        <Picker mode="selector" range={types} value={typeIndex} onChange={e => {
          const idx = Number(e.detail.value);
          setTypeIndex(idx);
          setType(idx === 0 ? '' : idx === 1 ? 'in' : 'out');
        }}>
          <View className={styles.filterSelect}>{types[typeIndex]}</View>
        </Picker>
        <Picker mode="date" value={fromDate} onChange={e=>setFromDate(e.detail.value)}><View className={styles.datePicker}>{fromDate || '开始日期'}</View></Picker>
        <Picker mode="date" value={toDate} onChange={e=>setToDate(e.detail.value)}><View className={styles.datePicker}>{toDate || '结束日期'}</View></Picker>
        <View><Text>显示作废历史</Text><Switch checked={includeVoided} onChange={e => setIncludeVoided(e.detail.value)} /></View>
      </View>

      {(filterCustomerId || filterSupplierId) && (
        <View className={styles.customerFilterBar}>
          <Text className={styles.customerFilterText}>{filterSupplierId ? '当前供应商' : '当前客户'}：{filterCustomerName || `#${filterSupplierId || filterCustomerId}`}</Text>
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
              <View className={styles.titleWrap}>
                <Text className={styles.itemName}>{productName(t.product_id, t.product_name)}</Text>
                {!!t.voided_at && <Text className={styles.tagOut}>已作废 · 不计库存及金额</Text>}
                {t.customer_name && (
                  <Text className={styles.customerName}>{t.customer_name}</Text>
                )}
              </View>
              {t.type === 'in'
                ? <Text className={styles.tagIn}>入库</Text>
                : t.type === 'adjustment' ? <Text className={styles.tagIn}>盘点</Text> : <Text className={styles.tagOut}>出库</Text>}
            </View>

            <View className={styles.metaBlock}>
              <Text className={styles.itemTime}>{formatShortTime(t.created_at)}</Text>
              <Text className={styles.itemRemark}>
                {t.operator || t.remark
                  ? `${t.operator ? `操作人：${t.operator}` : ''}${t.operator && t.remark ? ' · ' : ''}${t.remark ? `备注：${t.remark}` : ''}`
                  : '暂无备注'}
              </Text>
              <Text className={styles.itemRemark}>规格：{t.specification || '无'} · 材质：{t.material || '无'} · {t.unit || ''} · 单价 ¥{Number(t.unit_price || 0).toFixed(2)} · 金额 ¥{Number(t.amount || 0).toFixed(2)}</Text>
            </View>

            <View className={styles.itemBottom}>
              <Text className={styles.itemQtyLabel}>数量</Text>
              <View className={styles.itemBottomRight}>
                <Text className={styles.itemQty} style={{ color: t.type === 'out' ? '#dc2626' : '#16a34a' }}>
                  {t.type === 'adjustment' ? `${Number(t.adjustment) >= 0 ? '+' : ''}${t.adjustment ?? t.quantity}` : `${t.type === 'out' ? '-' : '+'}${t.quantity}`}{t.unit}
                </Text>
              </View>
            </View>
          </View>
        ))
      )}
    </ScrollView>
  );
};

export default RecordsPage;
