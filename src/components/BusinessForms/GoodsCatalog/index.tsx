import { useSharedRefresh } from '@/services/shared-refresh';
import React, { useState, useCallback, useEffect } from 'react';
import { View, Text, ScrollView, Image, Input, Picker } from '@tarojs/components';
import Taro from '@tarojs/taro';
import { addProduct, deleteProduct, getProduct, updateProduct, uploadProductImage } from '@/services/api';
import { formatMoney } from '@/utils/format';
import { getBaseUrl } from '@/services/request';
import { invalidateProducts, loadProducts } from '@/services/product-store';
import { numberValue, sanitizeDecimalInput } from '@/utils/stock-math';
import type { Product, ProductForm } from '@/types';
import SwipeRow from '@/components/SwipeRow';
import styles from '@/components/BusinessForms/GoodsCatalog/index.module.scss';
import { useRemoteData } from '@/hooks/useRemoteData';
import BusinessHeader from '@/components/BusinessHeader';

const units = ['件', '箱', '个', '千克'];
const emptyForm = {
  name: '', specification: '', material: '', category: '', corrugation: '',
  layers: '0', weight: '0', length: '0', width: '0', unit: '件', price: '0',
  stock: '0', safety: '0'
};
type ProductDraft = typeof emptyForm;

const openWorkbench = (section: 'stock' | 'records') => {
  void Taro.navigateTo({ url: '/pages/management/index?section=' + section });
};

async function compressImageDataUrl(dataUrl: string): Promise<string> {
  const browser = globalThis as any;
  if (!browser.document || !browser.Image || !browser.document.createElement) return dataUrl;
  try {
    const image = await new Promise<any>((resolve, reject) => {
      const value = new browser.Image();
      value.onload = () => resolve(value);
      value.onerror = reject;
      value.src = dataUrl;
    });
    const maxEdge = 1600;
    const sourceWidth = image.naturalWidth || image.width;
    const sourceHeight = image.naturalHeight || image.height;
    const scale = Math.min(1, maxEdge / Math.max(sourceWidth, sourceHeight));
    const canvas = browser.document.createElement('canvas');
    canvas.width = Math.max(1, Math.round(sourceWidth * scale));
    canvas.height = Math.max(1, Math.round(sourceHeight * scale));
    const context = canvas.getContext('2d');
    if (!context) return dataUrl;
    context.fillStyle = '#fff';
    context.fillRect(0, 0, canvas.width, canvas.height);
    context.drawImage(image, 0, 0, canvas.width, canvas.height);
    const compressed = canvas.toDataURL('image/jpeg', 0.82);
    return compressed.length < dataUrl.length ? compressed : dataUrl;
  } catch (error) {
    return dataUrl;
  }
}

type ProductListRowProps = {
  product: Product;
  open: boolean;
  onActiveChange: (id: number, open: boolean) => void;
  onEdit: (id: number) => void;
  onDelete: (id: number, name: string) => void;
  onImage: (product: Product) => void;
};

// Keep row-local actions and rendering out of the page render path. Product
// forms can update frequently while another row is being edited; a stable,
// memoized row means unchanged products keep their DOM and image work.
const ProductListRow = React.memo(function ProductListRow({
  product,
  open,
  onActiveChange,
  onEdit,
  onDelete,
  onImage
}: ProductListRowProps) {
  return (
    <SwipeRow
      open={open}
      onOpenChange={nextOpen => onActiveChange(product.id, nextOpen)}
      onTap={() => onEdit(product.id)}
      actions={[
        { text: '编辑', bg: '#2f6bff', onClick: () => onEdit(product.id) },
        { text: '停用', bg: '#dc2626', onClick: () => onDelete(product.id, product.name) }
      ]}
    >
      <View className={styles.listItem}>
        {product.image_url && <Image className={styles.thumb} lazyLoad src={/^https?:/.test(product.image_url) ? product.image_url : `${getBaseUrl()}${product.image_url}`} mode='aspectFill' />}
        <View className={styles.itemTop}>
          <Text className={styles.itemName}>{product.name}</Text>
        </View>
        <Text className={styles.itemMeta}>{product.category || '未分类'} · {product.unit} · {formatMoney(product.price)} · 库存 {product.stock}</Text>
        <View className={styles.itemActions}>
          <View className={styles.btnIn} onClick={event => { event.stopPropagation(); onImage(product); }}>图片</View>
          <View className={styles.btnOut} onClick={event => { event.stopPropagation(); openWorkbench('records'); }}>业务记录</View>
          <View className={styles.btnIn} onClick={event => { event.stopPropagation(); openWorkbench('stock'); }}>查看库存</View>
        </View>
      </View>
    </SwipeRow>
  );
});

const ProductsPage: React.FC = () => {
  // 手动刷新与共享刷新都强制读取：30 秒缓存只用于页面切换时的导航共享。
  const loadProductData = useCallback(() => loadProducts(true), []);
  const remote = useRemoteData(loadProductData, [] as Product[]);
  const list = remote.data;
  const loading = remote.loading;
  const loadError = remote.loadError;
  const load = remote.reload;
  useSharedRefresh(load);
  // 当前左滑展开的行（一次只开一行）
  const [activeId, setActiveId] = useState<number | null>(null);
  const [editor, setEditor] = useState<{ productId: number | null; draft: ProductDraft } | null>(null);
  const [editorLoading, setEditorLoading] = useState(false);
  const [editorError, setEditorError] = useState('');
  const [saving, setSaving] = useState(false);
  const handleActiveChange = useCallback((id: number, open: boolean) => {
    setActiveId(open ? id : null);
  }, []);

  const handleAdd = () => {
    setEditorError('');
    setEditor({ productId: null, draft: { ...emptyForm } });
  };

  const handleEdit = useCallback((id: number) => {
    setEditorError('');
    setEditor({ productId: id, draft: { ...emptyForm } });
    setEditorLoading(true);
    void getProduct(id, { forceNetwork: true }).then(product => {
      setEditor(current => current?.productId === id ? {
        productId: id,
        draft: {
          name: product.name, specification: product.specification || '', material: product.material || '',
          category: product.category || '', corrugation: product.corrugation || '', layers: String(product.layers || 0),
          weight: String(product.weight || 0), length: String(product.length || 0), width: String(product.width || 0),
          unit: product.unit || '件', price: String(product.price || 0), stock: String(product.stock || 0),
          safety: String(product.safety_stock || 0)
        }
      } : current);
    }).catch(error => {
      setEditorError(error?.message || '商品资料加载失败，请关闭后重试');
    }).finally(() => setEditorLoading(false));
  }, []);

  useEffect(() => {
    if (!editor) return;
    const close = (event: KeyboardEvent) => { if (event.key === 'Escape' && !saving) setEditor(null); };
    window.addEventListener('keydown', close);
    return () => window.removeEventListener('keydown', close);
  }, [editor, saving]);

  const updateDraft = (key: keyof ProductDraft, value: string) => {
    setEditor(current => current ? { ...current, draft: { ...current.draft, [key]: value } } : null);
  };

  const saveProduct = async () => {
    if (!editor || saving || editorLoading || editorError) return;
    const draft = editor.draft;
    if (!draft.name.trim()) { Taro.showToast({ title: '请输入商品名称', icon: 'none' }); return; }
    const parse = (value: string, label: string) => {
      try { return numberValue(value, label); }
      catch (error) { Taro.showToast({ title: error instanceof Error ? error.message : `${label}无效`, icon: 'none' }); return undefined; }
    };
    const parsed = {
      weight: parse(draft.weight, '克重'), length: parse(draft.length, '长度'), width: parse(draft.width, '宽度'),
      layers: parse(draft.layers, '层数'), price: parse(draft.price, '单价'),
      stock: parse(draft.stock, '初始库存'), safety: parse(draft.safety, '安全库存')
    };
    if (Object.values(parsed).some(value => value === undefined)) return;
    const data: ProductForm = {
      name: draft.name.trim(), specification: draft.specification.trim(), material: draft.material.trim(),
      category: draft.category.trim(), corrugation: draft.corrugation.trim(), layers: parsed.layers!,
      weight: parsed.weight!, length: parsed.length!, width: parsed.width!, unit: draft.unit,
      price: parsed.price!, stock: parsed.stock!, safety_stock: parsed.safety!
    };
    setSaving(true);
    try {
      if (editor.productId) {
        const { stock: _stock, ...changes } = data;
        await updateProduct(editor.productId, changes);
      } else {
        await addProduct(data);
      }
      invalidateProducts();
      setEditor(null);
      Taro.showToast({ title: '保存成功', icon: 'success' });
      load();
    } catch (error) {
      Taro.showToast({ title: error?.message || '保存失败', icon: 'none' });
    } finally {
      setSaving(false);
    }
  };

  const handleDelete = useCallback(async (id: number, name: string) => {
    const res = await Taro.showModal({ title: '停用确认', content: `确定停用「${name}」？历史出入库记录会保留。`, confirmColor: '#dc2626' });
    if (res.confirm) {
      try {
        await deleteProduct(id);
        invalidateProducts();
        Taro.showToast({ title: '已停用，历史记录已保留', icon: 'success' });
        load();
      } catch (e) { console.error('[Products] delete failed', e); }
    }
  }, [load]);
  const handleImage = useCallback(async (p: Product) => {
    try {
      const chosen = await Taro.chooseImage({ count: 1, sizeType: ['compressed'], sourceType: ['album', 'camera'] });
      const filePath = chosen.tempFilePaths[0];
      const base64 = await new Promise<string>((resolve, reject) => {
        const manager = (Taro as any).getFileSystemManager?.();
        if (manager?.readFile) manager.readFile({ filePath, encoding: 'base64', success: (r:any) => resolve(`data:image/jpeg;base64,${r.data}`), fail: reject });
        else { const reader = new FileReader(); reader.onload = () => resolve(String(reader.result)); reader.onerror = reject; fetch(filePath).then(r=>r.blob()).then(blob=>reader.readAsDataURL(blob)).catch(reject); }
      });
      const compressed = await compressImageDataUrl(base64);
      await uploadProductImage(p.id, compressed); invalidateProducts(); Taro.showToast({ title: '图片已保存', icon: 'success' }); load();
    } catch (e) { if (e?.errMsg && /cancel/i.test(e.errMsg)) return; Taro.showToast({ title: e?.message || '图片上传失败', icon: 'none' }); }
  }, [load]);

  return (
    <ScrollView scrollY className={styles.container} onRefresherRefresh={load} refresherEnabled refresherTriggered={false}>
      <BusinessHeader title='商品资料' />
      <View className={styles.toolbar}><View className={styles.addBtn} onClick={handleAdd}>+ 新增</View></View>

      {loading ? (
        <View className={styles.empty}>正在加载商品资料…</View>
      ) : loadError ? (
        <View className={styles.empty} onClick={load}>{loadError} · 点击重试</View>
      ) : list.length === 0 ? (
        <View className={styles.empty}>暂无商品，点击右上角&quot;新增&quot;</View>
      ) : (
        list.map(product => <ProductListRow
          key={product.id}
          product={product}
          open={activeId === product.id}
          onActiveChange={handleActiveChange}
          onEdit={handleEdit}
          onDelete={handleDelete}
          onImage={handleImage}
        />)
      )}
      {editor && <View className={styles.editorBackdrop} onClick={() => { if (!saving) setEditor(null); }}>
        <View className={styles.editorSheet} onClick={event => event.stopPropagation()}>
          <View className={styles.editorHeader}><Text className={styles.editorTitle}>{editor.productId ? '编辑商品' : '新增商品'}</Text><View className={styles.editorClose} aria-label='关闭商品编辑' onClick={() => { if (!saving) setEditor(null); }}>×</View></View>
          {editorLoading ? <View className={styles.empty}>正在加载商品资料…</View> : <>
            {editorError && <View className={styles.editorError} onClick={() => editor.productId && handleEdit(editor.productId)}>{editorError} · 点击重试</View>}
            <ScrollView scrollY className={styles.editorBody}>
              <Text className={styles.editorLabel}>商品名称 *</Text><Input className={styles.editorInput} maxlength={50} placeholder='请输入商品名称' value={editor.draft.name} disabled={saving || Boolean(editorError)} onInput={event => updateDraft('name', event.detail.value)} />
              <View className={styles.editorRow}>
                <View className={styles.editorColumn}><Text className={styles.editorLabel}>规格（可选）</Text><Input className={styles.editorInput} maxlength={100} placeholder='输入或选择规格' value={editor.draft.specification} disabled={saving || Boolean(editorError)} onInput={event => updateDraft('specification', event.detail.value)} /></View>
                <View className={styles.editorColumn}><Text className={styles.editorLabel}>材质（可选）</Text><Input className={styles.editorInput} maxlength={100} placeholder='输入或选择材质' value={editor.draft.material} disabled={saving || Boolean(editorError)} onInput={event => updateDraft('material', event.detail.value)} /></View>
              </View>
              <Text className={styles.editorLabel}>分类</Text><Input className={styles.editorInput} maxlength={50} placeholder='如：食品、日用品' value={editor.draft.category} disabled={saving || Boolean(editorError)} onInput={event => updateDraft('category', event.detail.value)} />
              <Text className={styles.editorLabel}>楞型</Text><Input className={styles.editorInput} maxlength={100} placeholder='如：B楞、E楞、BC楞' value={editor.draft.corrugation} disabled={saving || Boolean(editorError)} onInput={event => updateDraft('corrugation', event.detail.value)} />
              <View className={styles.editorRow}>
                <View className={styles.editorColumn}><Text className={styles.editorLabel}>层数</Text><Input className={styles.editorInput} type='number' value={editor.draft.layers} disabled={saving || Boolean(editorError)} onInput={event => updateDraft('layers', sanitizeDecimalInput(event.detail.value, 0))} /></View>
                <View className={styles.editorColumn}><Text className={styles.editorLabel}>克重（g/m²）</Text><Input className={styles.editorInput} type='digit' value={editor.draft.weight} disabled={saving || Boolean(editorError)} onInput={event => updateDraft('weight', sanitizeDecimalInput(event.detail.value, 6))} /></View>
              </View>
              <View className={styles.editorRow}>
                <View className={styles.editorColumn}><Text className={styles.editorLabel}>长（mm）</Text><Input className={styles.editorInput} type='digit' value={editor.draft.length} disabled={saving || Boolean(editorError)} onInput={event => updateDraft('length', sanitizeDecimalInput(event.detail.value, 6))} /></View>
                <View className={styles.editorColumn}><Text className={styles.editorLabel}>宽（mm）</Text><Input className={styles.editorInput} type='digit' value={editor.draft.width} disabled={saving || Boolean(editorError)} onInput={event => updateDraft('width', sanitizeDecimalInput(event.detail.value, 6))} /></View>
              </View>
              <Text className={styles.editorLabel}>单位</Text><Picker mode='selector' range={units} value={Math.max(0, units.indexOf(editor.draft.unit))} disabled={saving || Boolean(editorError)} onChange={event => updateDraft('unit', units[Number(event.detail.value)] || '件')}><View className={styles.editorInput}>{editor.draft.unit}</View></Picker>
              <View className={styles.editorRow}>
                <View className={styles.editorColumn}><Text className={styles.editorLabel}>单价</Text><Input className={styles.editorInput} type='digit' value={editor.draft.price} disabled={saving || Boolean(editorError)} onInput={event => updateDraft('price', sanitizeDecimalInput(event.detail.value, 2))} /></View>
                <View className={styles.editorColumn}><Text className={styles.editorLabel}>安全库存</Text><Input className={styles.editorInput} type='number' value={editor.draft.safety} disabled={saving || Boolean(editorError)} onInput={event => updateDraft('safety', sanitizeDecimalInput(event.detail.value, 6))} /></View>
              </View>
              {!editor.productId && <><Text className={styles.editorLabel}>初始库存</Text><Input className={styles.editorInput} type='number' value={editor.draft.stock} disabled={saving} onInput={event => updateDraft('stock', sanitizeDecimalInput(event.detail.value, 6))} /></>}
            </ScrollView>
            <View className={styles.editorActions}><View className={styles.editorCancel} onClick={() => { if (!saving) setEditor(null); }}>取消</View><View className={styles.editorSave} onClick={() => void saveProduct()}>{saving ? '正在保存…' : '保存商品'}</View></View>
          </>}
        </View>
      </View>}
    </ScrollView>
  );
};

export default ProductsPage;
