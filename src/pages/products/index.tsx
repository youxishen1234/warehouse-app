import { useSharedRefresh } from '@/services/shared-refresh';
import React, { useState, useCallback } from 'react';
import { View, Text, ScrollView, Image } from '@tarojs/components';
import Taro from '@tarojs/taro';
import { deleteProduct, uploadProductImage } from '@/services/api';
import { formatMoney } from '@/utils/format';
import { getBaseUrl } from '@/services/request';
import { invalidateProducts, loadProducts } from '@/services/product-store';
import type { Product } from '@/types';
import SwipeRow from '@/components/SwipeRow';
import styles from './index.module.scss';
import { useRemoteData } from '@/hooks/useRemoteData';

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
          <View className={styles.btnOut} onClick={event => { event.stopPropagation(); goOutbound(product); }}>出库</View>
          <View className={styles.btnIn} onClick={event => { event.stopPropagation(); goInbound(product); }}>入库</View>
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
  const handleActiveChange = useCallback((id: number, open: boolean) => {
    setActiveId(open ? id : null);
  }, []);

  const handleAdd = () => {
    Taro.navigateTo({ url: '/pages/product-edit/index' });
  };

  const handleEdit = useCallback((id: number) => {
    Taro.navigateTo({ url: `/pages/product-edit/index?id=${id}` });
  }, []);

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
    </ScrollView>
  );
};

export default ProductsPage;
