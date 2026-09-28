import React, { useCallback, useEffect, useRef, useState } from 'react';
import { View, Text, ScrollView } from '@tarojs/components';
import Taro from '@tarojs/taro';
import { getTransactionsPage } from '@/services/api';
import { useSharedRefresh } from '@/services/shared-refresh';
import { formatMoney, formatTime } from '@/utils/format';
import type { Transaction } from '@/types';
import styles from './index.module.scss';

const PAGE_SIZE = 200;

const PrintTransactionRow = React.memo(function PrintTransactionRow({ item }: { item: Transaction }) {
  return <View className={styles.row}>
    <Text>{formatTime(item.created_at)}</Text>
    <Text>{item.type === 'in' ? '??' : item.type === 'out' ? '??' : '??'}</Text>
    <Text>{item.product_name || '??'}</Text>
    <Text>{item.quantity}</Text>
    <Text>{formatMoney(item.amount || 0)}</Text>
  </View>;
});



export default function PrintCenterPage() {
  const [list, setList] = useState<Transaction[]>([]);
  const [page, setPage] = useState(1);
  const [loading, setLoading] = useState(false);
  const [hasMore, setHasMore] = useState(true);
  const [loadError, setLoadError] = useState(false);
  const sequence = useRef(0);
  const loadingRef = useRef(false);
  const hasMoreRef = useRef(true);

  const loadPage = useCallback(async (nextPage: number) => {
    if (loadingRef.current || !hasMoreRef.current && nextPage > 1) return;
    loadingRef.current = true;
    const current = ++sequence.current;
    setLoading(true);
    setLoadError(false);
    try {
      const result = await getTransactionsPage({ page: nextPage, page_size: PAGE_SIZE });
      if (current !== sequence.current) return;
      setList(previous => nextPage === 1 ? result.items : [...previous, ...result.items]);
      setPage(nextPage);
      hasMoreRef.current = nextPage * PAGE_SIZE < result.total;
      setHasMore(hasMoreRef.current);
    } catch (error) {
      if (current !== sequence.current) return;
      setLoadError(true);
      Taro.showToast({ title: (error as any)?.message || '流水加载失败', icon: 'none' });
    } finally {
      loadingRef.current = false;
      if (current === sequence.current) setLoading(false);
    }
  }, []);

  const refresh = useCallback(() => { void loadPage(1); }, [loadPage]);
  useSharedRefresh(refresh);

  useEffect(() => {
    void loadPage(1);
    return () => { sequence.current += 1; };
  }, [loadPage]);

  useEffect(() => {
    if (typeof window === 'undefined' || typeof document === 'undefined') return;
    const beforePrint = () => {
      const content = document.querySelector(`.${styles.page}`);
      if (content?.getClientRects().length) {
        content.closest('.taro_page')?.setAttribute('data-warehouse-print-page', 'transactions');
        document.body.setAttribute('data-warehouse-print', 'transactions');
      }
    };
    const afterPrint = () => {
      document.body.removeAttribute('data-warehouse-print');
      document.querySelectorAll('[data-warehouse-print-page="transactions"]').forEach(element => element.removeAttribute('data-warehouse-print-page'));
    };
    window.addEventListener('beforeprint', beforePrint);
    window.addEventListener('afterprint', afterPrint);
    return () => {
      window.removeEventListener('beforeprint', beforePrint);
      window.removeEventListener('afterprint', afterPrint);
      afterPrint();
    };
  }, []);

  const print = () => { const browser = globalThis as any; if (browser.print) browser.print(); };
  return (
    <ScrollView scrollY className={styles.page}>
      <View className={styles.toolbar}>
        <Text className={styles.title}>打印中心</Text>
        <View className={styles.printBtn} onClick={print}>打印当前流水</View>
      </View>
      <Text className={styles.hint}>当前按时间倒序分页加载，避免一次渲染全部历史流水；点击打印会打印已加载内容。</Text>
      <View className={styles.sheet}>
        <Text className={styles.sheetTitle}>出入库流水（已加载 {list.length} 条）</Text>
        {list.length === 0 && !loading ? <Text>暂无流水</Text> : list.map(item => <PrintTransactionRow key={item.id} item={item} />)}
        {loading && <Text className={styles.hint}>正在加载…</Text>}
        {!loading && hasMore && <View className={styles.moreBtn} onClick={() => void loadPage(list.length === 0 ? 1 : page + 1)}>{loadError ? '加载失败，点击重试' : '加载更多流水'}</View>}
        {!loading && !hasMore && list.length > 0 && <Text className={styles.endHint}>已显示全部流水</Text>}
      </View>
    </ScrollView>
  );
}
