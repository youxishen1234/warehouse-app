/* eslint-disable react/forbid-elements */
import { useSharedRefresh } from '@/services/shared-refresh';
import React, { useState, useCallback, useEffect } from 'react';
import { DemoPage, DemoSheet, DemoField } from '@/components/DemoUI';
import Taro from '@tarojs/taro';
import { addProduct, deleteProduct, getProduct, updateProduct, uploadProductImage } from '@/services/api';
import { formatMoney } from '@/utils/format';
import { getBaseUrl } from '@/services/request';
import { invalidateProducts, loadProducts } from '@/services/product-store';
import { numberValue, sanitizeDecimalInput } from '@/utils/stock-math';
import type { Product, ProductForm } from '@/types';
import { useRemoteData } from '@/hooks/useRemoteData';

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
  onEdit: (id: number) => void;
  onDelete: (id: number, name: string) => void;
  onImage: (product: Product) => void;
};

// Keep row-local actions and rendering out of the page render path. Product
// forms can update frequently while another row is being edited; a stable,
// memoized row means unchanged products keep their DOM and image work.
const ProductListRow = React.memo(function ProductListRow({
  product,
  onEdit,
  onDelete,
  onImage
}: ProductListRowProps) {
  return <article className='demo-card'>
    <div className='demo-row'>{product.image_url && <img alt={product.name} loading='lazy' width={40} height={40} style={{ objectFit: 'cover', borderRadius: 8 }} src={/^https?:/.test(product.image_url) ? product.image_url : `${getBaseUrl()}${product.image_url}`} />}<h3>{product.name}</h3><button type='button' className='demo-action' onClick={() => onEdit(product.id)}>编辑</button></div>
    <p>{[product.specification, product.material].filter(Boolean).join(' · ')}</p><div className='demo-goods'><span>{formatMoney(product.price)} / {product.unit}</span><span>库存 {product.stock} {product.unit}</span></div>
    <div className='demo-card-foot'><button type='button' className='demo-action' onClick={() => onImage(product)}>图片</button><button type='button' className='demo-action' onClick={() => openWorkbench('records')}>业务记录</button><button type='button' className='demo-action' onClick={() => openWorkbench('stock')}>查看库存</button><button type='button' className='demo-action' onClick={() => onDelete(product.id, product.name)}>停用</button></div>
  </article>;
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
  const [editor, setEditor] = useState<{ productId: number | null; draft: ProductDraft } | null>(null);
  const [editorLoading, setEditorLoading] = useState(false);
  const [editorError, setEditorError] = useState('');
  const [saving, setSaving] = useState(false);


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

  const field = (key: keyof ProductDraft, label: string, numeric = false, precision = 6) => editor && <DemoField label={label}><input aria-label={label} type={numeric ? 'number' : 'text'} maxLength={key === 'name' ? 50 : 100} value={editor.draft[key]} disabled={saving || !!editorError} onChange={event => updateDraft(key, numeric ? sanitizeDecimalInput(event.target.value, precision) : event.target.value)} /></DemoField>;
  return <DemoPage title='商品资料' action={<button type='button' className='demo-action' onClick={handleAdd}>＋ 新增</button>}>
    {loading ? <div className='demo-empty'>正在加载商品资料…</div> : loadError ? <div className='demo-error' role='alert'>{loadError}<button type='button' className='demo-action' onClick={() => void load()}>重新读取</button></div> : !list.length ? <div className='demo-empty'>暂无商品</div> : list.map(product => <ProductListRow key={product.id} product={product} onEdit={handleEdit} onDelete={handleDelete} onImage={handleImage} />)}
    {editor && <DemoSheet title={editor.productId ? '编辑商品' : '新增商品'} busy={saving} onClose={() => setEditor(null)} testId='product-editor'>
      {editorLoading ? <p>正在加载商品资料…</p> : <>
        {editorError && <div className='demo-error' role='alert'>{editorError}<button type='button' className='demo-action' onClick={() => editor.productId && handleEdit(editor.productId)}>重新读取</button></div>}
        {field('name', '商品名称（必填）')}{field('specification', '尺寸 / 规格')}{field('material', '材质 / 楞型')}
        <div className='demo-two'>{field('price', '单价（元）', true, 2)}<DemoField label='单位'><select aria-label='单位' value={editor.draft.unit} disabled={saving || !!editorError} onChange={event => updateDraft('unit', event.target.value)}>{Array.from(new Set([editor.draft.unit, ...units])).map(unit => <option key={unit}>{unit}</option>)}</select></DemoField></div>
        <details className='demo-more'><summary>更多资料</summary>{field('category', '分类')}{field('corrugation', '楞型')}<div className='demo-two'>{field('layers', '层数', true, 0)}{field('weight', '克重（g/m²）', true)}{field('length', '长（mm）', true)}{field('width', '宽（mm）', true)}</div>{field('safety', '安全库存', true)}{!editor.productId && field('stock', '初始库存', true)}</details>
        <button type='button' className='demo-primary' disabled={saving || !!editorError} onClick={() => void saveProduct()}>{saving ? '正在保存…' : '保存商品'}</button>
      </>}
    </DemoSheet>}
  </DemoPage>;
};

export default ProductsPage;
