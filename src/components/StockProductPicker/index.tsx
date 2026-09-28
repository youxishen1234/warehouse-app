import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { View, Text, Input, ScrollView } from '@tarojs/components';
import type { Product } from '@/types';
import styles from './index.module.scss';

type Props = { products: Product[]; value: number | null; onSelect: (product: Product) => void; disabled?: boolean; excluded?: number[] };
type ProductOptionProps = { product: Product; onSelect: (product: Product) => void };

const ProductOption = React.memo(function ProductOption({ product, onSelect }: ProductOptionProps) {
  return <View className={styles.option} onClick={() => onSelect(product)}>
    <Text>{product.name}</Text>
    <Text className={styles.detail}>{product.specification || '???'} ? ?? {product.stock}{product.unit} ? ?{product.price}/{product.unit}</Text>
  </View>;
});

export default function StockProductPicker({ products, value, onSelect, disabled, excluded = [] }: Props) {
  const [open, setOpen] = useState(false);
  const [query, setQuery] = useState('');
  const [filterQuery, setFilterQuery] = useState('');
  const debounceTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  useEffect(() => () => { if (debounceTimer.current) clearTimeout(debounceTimer.current); }, []);
  const selected = products.find(product => product.id === value);
  const keyword = filterQuery.trim().toLowerCase();
  // Parent forms create a fresh `excluded` array on every keystroke and line
  // update. Keep the dependency primitive so unchanged exclusions do not
  // trigger another full product scan.
  const excludedKey = [...new Set(excluded)].sort((a, b) => a - b).join(',');
  const excludedIds = useMemo(() => new Set(excludedKey ? excludedKey.split(',').map(Number) : []), [excludedKey]);
  const matches = useMemo(() => products.filter(product => !excludedIds.has(product.id) && [product.name, product.specification, product.material, product.corrugation, product.id].join(' ').toLowerCase().includes(keyword)), [products, excludedIds, keyword]);
  const closePicker = () => {
    setOpen(false);
    // Do not keep a previous search term or filtered slice alive after closing.
    // Reopening starts from the full product list and releases references held by
    // the temporary query state sooner on long inbound/outbound forms.
    setQuery('');
    setFilterQuery('');
  };
  const selectProduct = useCallback((product: Product) => {
    onSelect(product);
    setOpen(false);
    setQuery('');
    setFilterQuery('');
  }, [onSelect]);
  return <View className={styles.root}>
    <View className={styles.selected} onClick={() => { if (!disabled) { if (open) closePicker(); else setOpen(true); } }}>
      <Text>{selected ? `${selected.name} · ${selected.unit}` : value ? '商品已停用，请重新选择' : '选择已有商品'}</Text>
      <Text>{open ? '收起' : '选择'}</Text>
    </View>
    {open && !disabled && <View className={styles.options}>
      <Input className={styles.search} placeholder='搜索商品名称、规格、楞型' value={query} onInput={event => { const next = event.detail.value; setQuery(next); if (debounceTimer.current) clearTimeout(debounceTimer.current); debounceTimer.current = setTimeout(() => setFilterQuery(next), 300); }} />
      <ScrollView scrollY className={styles.list}>
        {matches.slice(0, 50).map(product => <ProductOption key={product.id} product={product} onSelect={selectProduct} />)}
        {!matches.length && <Text className={styles.detail}>{products.length ? '没有可选商品，请换个关键词或合并已有明细' : '暂无商品，请先在商品管理新增'}</Text>}
        {matches.length > 50 && <Text className={styles.detail}>还有 {matches.length - 50} 项，请输入关键词缩小范围</Text>}
      </ScrollView>
    </View>}
  </View>;
}
