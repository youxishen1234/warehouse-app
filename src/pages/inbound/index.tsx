import React, { useState, useEffect, useCallback } from 'react';
import { View, Text, Input, ScrollView, Picker } from '@tarojs/components';
import Taro, { useDidShow } from '@tarojs/taro';
import { getProducts, stockIn, getTransactions, getCustomers, deleteTransaction } from '@/services/api';
import { formatShortTime } from '@/utils/format';
import type { Product, Transaction, Customer } from '@/types';
import Icon from '@/components/Icon';
import styles from './index.module.scss';

// 跨页联动中转键：从商品/客户管理页跳转时自动预选
const TRANSIT_KEY = 'sg_transit';

const InboundPage: React.FC = () => {
  const [products, setProducts] = useState<Product[]>([]);
  const [customers, setCustomers] = useState<Customer[]>([]);
  const [selectedId, setSelectedId] = useState<number | null>(null);
  const [customerId, setCustomerId] = useState<number | null>(null);
  const [quantity, setQuantity] = useState('1');
  const [operator, setOperator] = useState('');
  const [remark, setRemark] = useState('');
  const [keyword, setKeyword] = useState('');
  const [recent, setRecent] = useState<Transaction[]>([]);
  const [submitting, setSubmitting] = useState(false);

  const loadProducts = useCallback(async () => {
    try {
      const list = await getProducts(keyword || undefined);
      setProducts(list);
    } catch (e) { console.error('[Inbound] loadProducts failed', e); }
  }, [keyword]);

  const loadRecent = useCallback(async () => {
    try {
      const list = await getTransactions({ type: 'in' });
      setRecent(list.slice(0, 8));
    } catch (e) { console.error('[Inbound] loadRecent failed', e); }
  }, []);

  const loadCustomers = useCallback(async () => {
    try {
      const list = await getCustomers();
      setCustomers(list);
    } catch (e) { console.error('[Inbound] loadCustomers failed', e); }
  }, []);

  useEffect(() => { loadProducts(); loadRecent(); loadCustomers(); }, [loadProducts, loadRecent, loadCustomers]);

  // 从商品/客户管理页联动跳转时自动预选商品与客户
  useDidShow(() => {
    const tr = Taro.getStorageSync(TRANSIT_KEY);
    if (!tr) return;
    Taro.removeStorageSync(TRANSIT_KEY);
    if (typeof tr.product_id === 'number') setSelectedId(tr.product_id);
    if (typeof tr.customer_id === 'number') setCustomerId(tr.customer_id);
    const tip = tr.product_name ? `已选中「${tr.product_name}」` : tr.customer_name ? `已关联客户「${tr.customer_name}」` : '';
    if (tip) Taro.showToast({ title: tip, icon: 'none', duration: 1500 });
  });

  const selectedProduct = products.find(p => p.id === selectedId);
  const selectedCustomer = customers.find(c => c.id === customerId);

  const handleConfirm = async () => {
    if (!selectedId) { Taro.showToast({ title: '请选择商品', icon: 'none' }); return; }
    const qty = Number(quantity);
    if (!qty || qty <= 0) { Taro.showToast({ title: '数量必须大于0', icon: 'none' }); return; }
    if (submitting) return;
    setSubmitting(true);
    try {
      await stockIn(selectedId, qty, operator, remark, customerId);
      Taro.showToast({ title: '入库成功', icon: 'success' });
      setSelectedId(null); setQuantity('1'); setOperator(''); setRemark(''); setCustomerId(null);
      loadProducts(); loadRecent();
    } catch (e) { console.error('[Inbound] confirm failed', e); }
    finally { setSubmitting(false); }
  };

  const handleDeleteRecent = async (tx: Transaction) => {
    const result = await Taro.showModal({ title: '删除入库记录', content: '删除后会自动扣减对应库存，确定继续吗？', confirmColor: '#dc2626' });
    if (!result.confirm) return;
    try { await deleteTransaction(tx.id); Taro.showToast({ title: '已删除', icon: 'success' }); loadProducts(); loadRecent(); }
    catch (e) { console.error('[Inbound] delete failed', e); }
  };

  const productOptions = products.map(p => `${p.name}${p.category ? `（${p.category}）` : ''}`);
  const customerOptions = ['不关联客户', ...customers.map(c => c.name)];

  return (
    <ScrollView scrollY className={styles.container} onRefresherRefresh={() => { loadProducts(); loadRecent(); }} refresherEnabled refresherTriggered={false}>
      <Text className={styles.sectionTitle}>商品信息</Text>
      <View className={styles.card}>
        <View className={styles.searchBox}>
          <Icon name="search" color="#9aa3b2" className={styles.searchIcon} />
          <Input className={styles.searchInput} placeholder="搜索商品名称或分类" value={keyword} onInput={e => setKeyword(e.detail.value)} />
        </View>

        <Picker mode="selector" range={productOptions} value={selectedId ? products.findIndex(p => p.id === selectedId) : 0} onChange={e => {
          const idx = Number(e.detail.value);
          setSelectedId(products[idx]?.id ?? null);
        }}>
          <View className={styles.pickerCell}>
            <Text className={selectedProduct ? styles.pickerText : styles.pickerPlaceholder}>
              {selectedProduct ? selectedProduct.name : '请选择商品'}
            </Text>
            <Icon name="chevron" color="#c0c6d0" className={styles.chevron} />
          </View>
        </Picker>

        {selectedProduct && (
          <View className={styles.productInfo}>
            <Icon name="box" color="#2f6bff" className={styles.infoIcon} />
            <View className={styles.infoTextWrap}>
              <Text className={styles.infoName}>{selectedProduct.name}</Text>
              <Text className={styles.infoStock}>当前库存 {selectedProduct.stock}{selectedProduct.unit} · 单价 ¥{selectedProduct.price}</Text>
            </View>
          </View>
        )}
      </View>

      <Text className={styles.sectionTitle}>入库信息</Text>
      <View className={styles.card}>
        <View className={styles.field}>
          <Text className={styles.fieldLabel}>客户 / 供应商</Text>
          <Picker
            mode="selector"
            range={customerOptions}
            value={customerId ? customers.findIndex(c => c.id === customerId) + 1 : 0}
            onChange={e => {
              const idx = Number(e.detail.value);
              setCustomerId(idx === 0 ? null : (customers[idx - 1]?.id ?? null));
            }}
          >
            <View className={styles.pickerCell}>
              <Text className={selectedCustomer ? styles.pickerText : styles.pickerPlaceholder}>
                {selectedCustomer ? selectedCustomer.name : '选择客户 / 供应商（选填）'}
              </Text>
              <Icon name="chevron" color="#c0c6d0" className={styles.chevron} />
            </View>
          </Picker>
        </View>
        <View className={styles.field}>
          <Text className={styles.fieldLabel}>入库数量 <Text className={styles.req}>*</Text></Text>
          <Input className={styles.fieldInput} type="number" value={quantity} onInput={e => setQuantity(e.detail.value)} />
        </View>
        <View className={styles.field}>
          <Text className={styles.fieldLabel}>操作人</Text>
          <Input className={styles.fieldInput} placeholder="选填" value={operator} onInput={e => setOperator(e.detail.value)} />
        </View>
        <View className={styles.fieldLast}>
          <Text className={styles.fieldLabel}>备注</Text>
          <Input className={styles.fieldInput} placeholder="选填" value={remark} onInput={e => setRemark(e.detail.value)} />
        </View>
      </View>

      <View className={`${styles.btnPrimary} ${submitting ? styles.btnDisabled : ''}`} onClick={handleConfirm}>{submitting ? '提交中…' : '确认入库'}</View>

      <Text className={styles.sectionTitle}>最近入库记录</Text>
      <View className={styles.card}>
        {recent.length === 0 ? (
          <View className={styles.empty}>暂无记录</View>
        ) : (
          recent.map(t => (
            <View key={t.id} className={styles.recentItem}>
              <View className={styles.recentDot} />
              <View className={styles.recentLeft}>
                <Text className={styles.recentName}>{products.find(p => p.id === t.product_id)?.name || '(已删除商品)'}{t.customer_name ? ` · ${t.customer_name}` : ''}</Text>
                <Text className={styles.recentTime}>{formatShortTime(t.created_at)}{t.operator ? ` · ${t.operator}` : ''}</Text>
              </View>
              <View className={styles.recentActions}>
                <Text className={styles.tagIn}>+{t.quantity}</Text>
                <Text className={styles.deleteBtn} onClick={() => handleDeleteRecent(t)}>删除</Text>
              </View>
            </View>
          ))
        )}
      </View>
    </ScrollView>
  );
};

export default InboundPage;
