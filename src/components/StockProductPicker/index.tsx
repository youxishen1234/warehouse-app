import { useState } from 'react';
import { View, Text, Input, ScrollView } from '@tarojs/components';
import type { Product } from '@/types';
import styles from './index.module.scss';

type Props = { products: Product[]; value: number | null; onSelect: (product: Product) => void; disabled?: boolean; excluded?: number[] };
export default function StockProductPicker({ products, value, onSelect, disabled, excluded = [] }: Props) {
  const [open, setOpen] = useState(false);
  const [query, setQuery] = useState('');
  const selected = products.find(product => product.id === value);
  const keyword = query.trim().toLowerCase();
  const matches = products.filter(product => !excluded.includes(product.id) && [product.name, product.specification, product.material, product.corrugation, product.id].join(' ').toLowerCase().includes(keyword));
  return <View className={styles.root}>
    <View className={styles.selected} onClick={() => { if (!disabled) setOpen(!open); }}>
      <Text>{selected ? `${selected.name} · ${selected.unit}` : value ? '商品已停用，请重新选择' : '选择已有商品'}</Text>
      <Text>{open ? '收起' : '选择'}</Text>
    </View>
    {open && !disabled && <View className={styles.options}>
      <Input className={styles.search} placeholder='搜索商品名称、规格、楞型' value={query} onInput={event => setQuery(event.detail.value)} />
      <ScrollView scrollY className={styles.list}>
        {matches.slice(0, 50).map(product => <View className={styles.option} key={product.id} onClick={() => { onSelect(product); setOpen(false); setQuery(''); }}>
          <Text>{product.name}</Text>
          <Text className={styles.detail}>{product.specification || '未填规格'} · 库存 {product.stock}{product.unit} · ¥{product.price}/{product.unit}</Text>
        </View>)}
        {!matches.length && <Text className={styles.detail}>{products.length ? '没有可选商品，请换个关键词或合并已有明细' : '暂无商品，请先在商品管理新增'}</Text>}
        {matches.length > 50 && <Text className={styles.detail}>还有 {matches.length - 50} 项，请输入关键词缩小范围</Text>}
      </ScrollView>
    </View>}
  </View>;
}
