import React, { useState, useEffect, useMemo, useRef } from 'react';
import { View, Text, Input, Picker, ScrollView } from '@tarojs/components';
import Taro, { useRouter } from '@tarojs/taro';
import { getProduct, addProduct, updateProduct } from '@/services/api';
import type { ProductForm } from '@/types';
import { numberValue, sanitizeDecimalInput } from '@/utils/stock-math';
import { invalidateProducts, loadProducts } from '@/services/product-store';
import { refreshSharedData } from '@/services/shared-refresh';
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
  const [corrugation, setCorrugation] = useState('');
  const [weight, setWeight] = useState('0');
  const [length, setLength] = useState('0');
  const [width, setWidth] = useState('0');
  const [layers, setLayers] = useState('0');
  const [unit, setUnit] = useState('件');
  const [price, setPrice] = useState('0');
  const [stock, setStock] = useState('0');
  const [safety, setSafety] = useState('0');
  const [unitIndex, setUnitIndex] = useState(0);
  const [saving, setSaving] = useState(false);
  const [historySpecs, setHistorySpecs] = useState<string[]>([]);
  const [historyMaterials, setHistoryMaterials] = useState<string[]>([]);
  const [specQuery, setSpecQuery] = useState('');
  const [materialQuery, setMaterialQuery] = useState('');
  const [showSpecs, setShowSpecs] = useState(false);
  const [showMaterials, setShowMaterials] = useState(false);
  const savingRef = useRef(false);
  const specTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const materialTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  useEffect(() => () => { if (specTimer.current) clearTimeout(specTimer.current); if (materialTimer.current) clearTimeout(materialTimer.current); }, []);
  const filteredSpecs = useMemo(() => historySpecs.filter(value => !specQuery.trim() || value.toLowerCase().includes(specQuery.trim().toLowerCase())), [historySpecs, specQuery]);
  const filteredMaterials = useMemo(() => historyMaterials.filter(value => !materialQuery.trim() || value.toLowerCase().includes(materialQuery.trim().toLowerCase())), [historyMaterials, materialQuery]);

  useEffect(() => {
    let localSpecs: string[] = [], localMaterials: string[] = [];
    try { const saved = Taro.getStorageSync(HISTORY_KEY) || {}; localSpecs = Array.isArray(saved.specs) ? saved.specs : []; localMaterials = Array.isArray(saved.materials) ? saved.materials : []; } catch (e) { /* ignore */ }
    setHistorySpecs(unique(localSpecs)); setHistoryMaterials(unique(localMaterials));
    loadProducts().then(products => {
      setHistorySpecs(unique([...localSpecs, ...products.map(product => product.specification || '')]));
      setHistoryMaterials(unique([...localMaterials, ...products.map(product => product.material || '')]));
    }).catch(() => {});
    if (isEdit && editId) {
      getProduct(editId).then(p => {
        setName(p.name);
        setCategory(p.category);
        setSpecification(p.specification || ''); setMaterial(p.material || '');
        setCorrugation(p.corrugation || ''); setWeight(String(p.weight || 0)); setLength(String(p.length || 0)); setWidth(String(p.width || 0)); setLayers(String(p.layers || 0));
        setUnit(p.unit);
        setUnitIndex(units.indexOf(p.unit));
        setPrice(String(p.price));
        setStock(String(p.stock));
        setSafety(String(p.safety_stock));
      }).catch(e => console.error('[ProductEdit] load failed', e));
    }
  }, [isEdit, editId]);

  const handleSave = async () => {
    if (savingRef.current) return;
    if (!name.trim()) { Taro.showToast({ title: '请输入商品名称', icon: 'none' }); return; }
    const numeric = (value: string, label: string) => {
      try { return numberValue(value, label); }
      catch (error) { Taro.showToast({ title: error instanceof Error ? error.message : `${label}无效`, icon: 'none' }); return undefined; }
    };
    const parsed = {
      weight: numeric(weight, '克重'), length: numeric(length, '长度'), width: numeric(width, '宽度'),
      layers: numeric(layers, '层数'), price: numeric(price, '单价'), stock: numeric(stock, '初始库存'), safety: numeric(safety, '安全库存')
    };
    if (Object.values(parsed).some(value => value === undefined)) return;
    const data: ProductForm = {
      name: name.trim(),
      category: category.trim(),
      specification: specification.trim(), material: material.trim(),
      corrugation: corrugation.trim(), weight: parsed.weight!, length: parsed.length!, width: parsed.width!, layers: parsed.layers!,
      unit,
      price: parsed.price!,
      stock: parsed.stock!,
      safety_stock: parsed.safety!
    };
    try {
      savingRef.current = true;
      setSaving(true);
      if (isEdit && editId) {
        const { stock: _s, ...updateData } = data;
        await updateProduct(editId, updateData);
      } else {
        await addProduct(data);
      }
      invalidateProducts();
      // The write response may notify mounted lists before this form resumes.
      // Reload once after clearing their shared cache so returning shows the save.
      refreshSharedData();
      const saved = { specs: unique([data.specification || '', ...historySpecs]), materials: unique([data.material || '', ...historyMaterials]) };
      Taro.setStorageSync(HISTORY_KEY, saved);
      Taro.showToast({ title: '保存成功', icon: 'success' });
      setTimeout(() => Taro.navigateBack(), 1000);
    } catch (e) { savingRef.current = false; setSaving(false); console.error('[ProductEdit] save failed', e); Taro.showToast({ title: e?.message || '保存失败', icon: 'none' }); }
  };

  return (
    <ScrollView scrollY className={styles.container}>
      <View className={styles.form}>
        <View className={styles.field}>
          <Text className={styles.label}>商品名称 *</Text>
          <Input className={styles.input} maxlength={50} placeholder="请输入商品名称" value={name} onInput={e => setName(e.detail.value)} />
        </View>
        <View className={styles.row}><View className={styles.rowItem}><View className={styles.field}><Text className={styles.label}>规格（可选）</Text><View className={styles.combo}><Input className={styles.input} maxlength={100} placeholder="输入或选择规格" value={specification} onFocus={() => {setSpecQuery(specification);setShowSpecs(true)}} onInput={e=>{const value=e.detail.value;setSpecification(value);setShowSpecs(true);if(specTimer.current)clearTimeout(specTimer.current);specTimer.current=setTimeout(()=>setSpecQuery(value),300)}} /><Text className={styles.comboArrow} onClick={() => setShowSpecs(!showSpecs)}>⌄</Text></View>{showSpecs && filteredSpecs.length > 0 && <View className={styles.historyDropdown}>{filteredSpecs.map(value => <Text key={value} onClick={() => {setSpecification(value);setSpecQuery(value);setShowSpecs(false)}}>{value}</Text>)}</View>}</View></View><View className={styles.rowItem}><View className={styles.field}><Text className={styles.label}>材质（可选）</Text><View className={styles.combo}><Input className={styles.input} maxlength={100} placeholder="输入或选择材质" value={material} onFocus={() => {setMaterialQuery(material);setShowMaterials(true)}} onInput={e=>{const value=e.detail.value;setMaterial(value);setShowMaterials(true);if(materialTimer.current)clearTimeout(materialTimer.current);materialTimer.current=setTimeout(()=>setMaterialQuery(value),300)}} /><Text className={styles.comboArrow} onClick={() => setShowMaterials(!showMaterials)}>⌄</Text></View>{showMaterials && filteredMaterials.length > 0 && <View className={styles.historyDropdown}>{filteredMaterials.map(value => <Text key={value} onClick={() => {setMaterial(value);setMaterialQuery(value);setShowMaterials(false)}}>{value}</Text>)}</View>}</View></View></View>

        <View className={styles.field}>
          <Text className={styles.label}>分类</Text>
          <Input className={styles.input} maxlength={50} placeholder="如：食品、日用品" value={category} onInput={e => setCategory(e.detail.value)} />
        </View>

        <View className={styles.row}><View className={styles.rowItem}><View className={styles.field}><Text className={styles.label}>楞型</Text><Input className={styles.input} maxlength={100} placeholder="如：B楞、E楞、BC楞" value={corrugation} onInput={e => setCorrugation(e.detail.value)} /></View></View><View className={styles.rowItem}><View className={styles.field}><Text className={styles.label}>层数</Text><Input className={styles.input} type="number" value={layers} onInput={e => setLayers(sanitizeDecimalInput(e.detail.value, 0))} /></View></View></View>
        <View className={styles.row}><View className={styles.rowItem}><View className={styles.field}><Text className={styles.label}>克重（g/㎡）</Text><Input className={styles.input} type="digit" value={weight} onInput={e => setWeight(sanitizeDecimalInput(e.detail.value, 6))} /></View></View><View className={styles.rowItem}><View className={styles.field}><Text className={styles.label}>长（mm）</Text><Input className={styles.input} type="digit" value={length} onInput={e => setLength(sanitizeDecimalInput(e.detail.value, 6))} /></View></View></View>
        <View className={styles.row}><View className={styles.rowItem}><View className={styles.field}><Text className={styles.label}>宽（mm）</Text><Input className={styles.input} type="digit" value={width} onInput={e => setWidth(sanitizeDecimalInput(e.detail.value, 6))} /></View></View></View>

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
              <Input className={styles.input} type="digit" value={price} onInput={e => setPrice(sanitizeDecimalInput(e.detail.value, 2))} />
            </View>
          </View>
          <View className={styles.rowItem}>
            <View className={styles.field}>
              <Text className={styles.label}>安全库存</Text>
              <Input className={styles.input} type="number" value={safety} onInput={e => setSafety(sanitizeDecimalInput(e.detail.value, 6))} />
            </View>
          </View>
        </View>

        {!isEdit && (
          <View className={styles.field}>
            <Text className={styles.label}>初始库存</Text>
            <Input className={styles.input} type="number" value={stock} onInput={e => setStock(sanitizeDecimalInput(e.detail.value, 6))} />
          </View>
        )}

      </View>
      <View className={styles.btnPrimary} onClick={handleSave}>{saving ? '正在保存' : '保存'}</View>
    </ScrollView>
  );
};

export default ProductEditPage;
