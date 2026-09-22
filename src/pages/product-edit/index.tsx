import React, { useState, useEffect } from 'react';
import { View, Text, Input, Picker, ScrollView } from '@tarojs/components';
import Taro, { useRouter } from '@tarojs/taro';
import { getProduct, getProducts, addProduct, updateProduct } from '@/services/api';
import type { ProductForm } from '@/types';
import styles from './index.module.scss';

const units = ['件', '箱', '个', '千克'];
const HISTORY_KEY = 'warehouse-product-field-history-v1';
const unique = (values: string[]) => Array.from(new Set(values.map(value => value.trim()).filter(Boolean))).slice(0, 50);

const ProductEditPage: React.FC = () => {
  const router = useRouter();
  const editId = router.params.id ? Number(router.params.id) : null;
  const isEdit = !!editId;

  const [name, setName] = useState('');
  const [category, setCategory] = useState('');
  const [specification, setSpecification] = useState('');
  const [material, setMaterial] = useState('');
  const [unit, setUnit] = useState('件');
  const [price, setPrice] = useState('0');
  const [stock, setStock] = useState('0');
  const [safety, setSafety] = useState('0');
  const [unitIndex, setUnitIndex] = useState(0);
  const [saving, setSaving] = useState(false);
  const [historySpecs, setHistorySpecs] = useState<string[]>([]);
  const [historyMaterials, setHistoryMaterials] = useState<string[]>([]);
  const [showSpecs, setShowSpecs] = useState(false);
  const [showMaterials, setShowMaterials] = useState(false);
  const filteredSpecs = historySpecs.filter(value => !specification.trim() || value.toLowerCase().includes(specification.trim().toLowerCase()));
  const filteredMaterials = historyMaterials.filter(value => !material.trim() || value.toLowerCase().includes(material.trim().toLowerCase()));

  useEffect(() => {
    let localSpecs: string[] = [], localMaterials: string[] = [];
    try { const saved = Taro.getStorageSync(HISTORY_KEY) || {}; localSpecs = Array.isArray(saved.specs) ? saved.specs : []; localMaterials = Array.isArray(saved.materials) ? saved.materials : []; } catch (e) { /* ignore */ }
    setHistorySpecs(unique(localSpecs)); setHistoryMaterials(unique(localMaterials));
    getProducts().then(products => {
      setHistorySpecs(unique([...localSpecs, ...products.map(product => product.specification || '')]));
      setHistoryMaterials(unique([...localMaterials, ...products.map(product => product.material || '')]));
    }).catch(() => {});
    if (isEdit && editId) {
      getProduct(editId).then(p => {
        setName(p.name);
        setCategory(p.category);
        setSpecification(p.specification || ''); setMaterial(p.material || '');
        setUnit(p.unit);
        setUnitIndex(units.indexOf(p.unit));
        setPrice(String(p.price));
        setStock(String(p.stock));
        setSafety(String(p.safety_stock));
      }).catch(e => console.error('[ProductEdit] load failed', e));
    }
  }, [isEdit, editId]);

  const handleSave = async () => {
    if (saving) return;
    if (!name.trim()) { Taro.showToast({ title: '请输入商品名称', icon: 'none' }); return; }
    const data: ProductForm = {
      name: name.trim(),
      category: category.trim(),
      specification: specification.trim(), material: material.trim(),
      unit,
      price: Number(price) || 0,
      stock: Number(stock) || 0,
      safety_stock: Number(safety) || 0
    };
    try {
      setSaving(true);
      if (isEdit && editId) {
        const { stock: _s, ...updateData } = data;
        await updateProduct(editId, updateData);
      } else {
        await addProduct(data);
      }
      const saved = { specs: unique([data.specification || '', ...historySpecs]), materials: unique([data.material || '', ...historyMaterials]) };
      Taro.setStorageSync(HISTORY_KEY, saved);
      Taro.showToast({ title: '保存成功', icon: 'success' });
      setTimeout(() => Taro.navigateBack(), 1000);
    } catch (e) { setSaving(false); console.error('[ProductEdit] save failed', e); Taro.showToast({ title: e?.message || '保存失败', icon: 'none' }); }
  };

  return (
    <ScrollView scrollY className={styles.container}>
      <View className={styles.form}>
        <View className={styles.field}>
          <Text className={styles.label}>商品名称 *</Text>
          <Input className={styles.input} placeholder="请输入商品名称" value={name} onInput={e => setName(e.detail.value)} />
        </View>
        <View className={styles.row}><View className={styles.rowItem}><View className={styles.field}><Text className={styles.label}>规格（可选）</Text><View className={styles.combo}><Input className={styles.input} placeholder="输入或选择规格" value={specification} onFocus={() => setShowSpecs(true)} onInput={e=>{setSpecification(e.detail.value);setShowSpecs(true)}} /><Text className={styles.comboArrow} onClick={() => setShowSpecs(!showSpecs)}>⌄</Text></View>{showSpecs && filteredSpecs.length > 0 && <View className={styles.historyDropdown}>{filteredSpecs.map(value => <Text key={value} onClick={() => {setSpecification(value);setShowSpecs(false)}}>{value}</Text>)}</View>}</View></View><View className={styles.rowItem}><View className={styles.field}><Text className={styles.label}>材质（可选）</Text><View className={styles.combo}><Input className={styles.input} placeholder="输入或选择材质" value={material} onFocus={() => setShowMaterials(true)} onInput={e=>{setMaterial(e.detail.value);setShowMaterials(true)}} /><Text className={styles.comboArrow} onClick={() => setShowMaterials(!showMaterials)}>⌄</Text></View>{showMaterials && filteredMaterials.length > 0 && <View className={styles.historyDropdown}>{filteredMaterials.map(value => <Text key={value} onClick={() => {setMaterial(value);setShowMaterials(false)}}>{value}</Text>)}</View>}</View></View></View>

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

      </View>
      <View className={styles.btnPrimary} onClick={handleSave}>{saving ? '正在保存' : '保存'}</View>
    </ScrollView>
  );
};

export default ProductEditPage;
