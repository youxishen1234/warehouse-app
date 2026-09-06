import React, { useState, useEffect } from 'react';
import { View, Text, Input, Picker, ScrollView } from '@tarojs/components';
import Taro, { useRouter } from '@tarojs/taro';
import { getProduct, addProduct, updateProduct } from '@/services/api';
import type { ProductForm } from '@/types';
import styles from './index.module.scss';

const units = ['件', '箱', '个', '千克'];

const ProductEditPage: React.FC = () => {
  const router = useRouter();
  const editId = router.params.id ? Number(router.params.id) : null;
  const isEdit = !!editId;

  const [name, setName] = useState('');
  const [category, setCategory] = useState('');
  const [unit, setUnit] = useState('件');
  const [price, setPrice] = useState('0');
  const [stock, setStock] = useState('0');
  const [safety, setSafety] = useState('0');
  const [unitIndex, setUnitIndex] = useState(0);

  useEffect(() => {
    if (isEdit && editId) {
      getProduct(editId).then(p => {
        setName(p.name);
        setCategory(p.category);
        setUnit(p.unit);
        setUnitIndex(units.indexOf(p.unit));
        setPrice(String(p.price));
        setStock(String(p.stock));
        setSafety(String(p.safety_stock));
      }).catch(e => console.error('[ProductEdit] load failed', e));
    }
  }, [isEdit, editId]);

  const handleSave = async () => {
    if (!name.trim()) { Taro.showToast({ title: '请输入商品名称', icon: 'none' }); return; }
    const data: ProductForm = {
      name: name.trim(),
      category: category.trim(),
      unit,
      price: Number(price) || 0,
      stock: Number(stock) || 0,
      safety_stock: Number(safety) || 0
    };
    try {
      if (isEdit && editId) {
        const { stock: _s, ...updateData } = data;
        await updateProduct(editId, updateData);
      } else {
        await addProduct(data);
      }
      Taro.showToast({ title: '保存成功', icon: 'success' });
      setTimeout(() => Taro.navigateBack(), 1000);
    } catch (e) { console.error('[ProductEdit] save failed', e); }
  };

  return (
    <ScrollView scrollY className={styles.container}>
      <View className={styles.form}>
        <View className={styles.field}>
          <Text className={styles.label}>商品名称 *</Text>
          <Input className={styles.input} placeholder="请输入商品名称" value={name} onInput={e => setName(e.detail.value)} />
        </View>

        <View className={styles.field}>
          <Text className={styles.label}>分类</Text>
          <Input className={styles.input} placeholder="如：食品、日用品" value={category} onInput={e => setCategory(e.detail.value)} />
        </View>

        <View className={styles.field}>
          <Text className={styles.label}>单位</Text>
          <Picker mode="selector" range={units} value={unitIndex} onChange={e => {
            const idx = Number(e.detail.value);
            setUnitIndex(idx);
            setUnit(units[idx]);
          }}>
            <View className={styles.picker}>{unit}</View>
          </Picker>
        </View>

        <View className={styles.row}>
          <View className={styles.rowItem}>
            <View className={styles.field}>
              <Text className={styles.label}>单价</Text>
              <Input className={styles.input} type="digit" value={price} onInput={e => setPrice(e.detail.value)} />
            </View>
          </View>
          <View className={styles.rowItem}>
            <View className={styles.field}>
              <Text className={styles.label}>安全库存</Text>
              <Input className={styles.input} type="number" value={safety} onInput={e => setSafety(e.detail.value)} />
            </View>
          </View>
        </View>

        {!isEdit && (
          <View className={styles.field}>
            <Text className={styles.label}>初始库存</Text>
            <Input className={styles.input} type="number" value={stock} onInput={e => setStock(e.detail.value)} />
          </View>
        )}

        <View className={styles.btnPrimary} onClick={handleSave}>保存</View>
      </View>
    </ScrollView>
  );
};

export default ProductEditPage;
