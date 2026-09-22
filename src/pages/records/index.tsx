import { useSharedRefresh } from '@/services/shared-refresh';
import React, { useState, useEffect, useCallback } from 'react';
import { View, Text, Input, ScrollView, Picker } from '@tarojs/components';
import Taro, { useRouter } from '@tarojs/taro';
import { getTransactions, getProducts } from '@/services/api';
import { getBaseUrl } from '@/services/request';
import { session } from '@/services/session';
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
  }, [type, filterCustomerId, filterSupplierId, fromDate, toDate]);

  useSharedRefresh(load);
  useEffect(() => { load(); }, [load]);

  const productName = (id: number) => products.find(p => p.id === id)?.name || '(已删除)';

  return (
    <ScrollView scrollY className={styles.container} onRefresherRefresh={load} refresherEnabled refresherTriggered={false}>
      <View className={styles.filterBox}>
        <View className={styles.exportBtn} onClick={async()=>{try{const token=session()?.token;const r=await Taro.downloadFile({url:`${getBaseUrl()}/api/export/transactions.csv`,header:token?{Authorization:`Bearer ${token}`}:{}});if(r.statusCode===200)Taro.showToast({title:'CSV已生成',icon:'success'});else throw new Error('导出失败')}catch(e){Taro.showToast({title:e?.message||'导出失败',icon:'none'});}}}>导出 CSV</View>
        <Picker mode="selector" range={types} value={typeIndex} onChange={e => {
          const idx = Number(e.detail.value);
          setTypeIndex(idx);
          setType(idx === 0 ? '' : idx === 1 ? 'in' : 'out');
        }}>
          <View className={styles.filterSelect}>{types[typeIndex]}</View>
        </Picker>
        <Picker mode="date" value={fromDate || undefined} onChange={e=>setFromDate(e.detail.value)}><View className={styles.datePicker}>{fromDate || '开始日期'}</View></Picker>
        <Picker mode="date" value={toDate || undefined} onChange={e=>setToDate(e.detail.value)}><View className={styles.datePicker}>{toDate || '结束日期'}</View></Picker>
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
                <Text className={styles.itemName}>{productName(t.product_id)}</Text>
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
                  {t.type === 'out' ? '-' : '+'}{t.quantity}
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
