/* eslint-disable react/forbid-elements */
// Desktop print controls use accessible native HTML selects.
import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { View, Text, ScrollView } from '@tarojs/components';
import Taro, { useRouter } from '@tarojs/taro';
import { getTransactions, getTransactionsPage } from '@/services/api';
import { useSharedRefresh } from '@/services/shared-refresh';
import { formatMoney, formatTime } from '@/utils/format';
import type { Transaction } from '@/types';
import DotMatrixPrint from '@/components/DotMatrixPrint';
import { documentFromTransactions, transactionPrintKey } from '@/utils/dot-matrix-print';
import type { PrintDocument } from '@/utils/dot-matrix-print';
import styles from './index.module.scss';

const PAGE_SIZE = 200;

const PrintTransactionRow = React.memo(function PrintTransactionRow({ item }: { item: Transaction }) {
  return <View className={styles.row}>
    <Text>{formatTime(item.created_at)}</Text>
    <Text>{item.type === 'in' ? '入库' : item.type === 'out' ? '出库' : '调整'}</Text>
    <Text>{item.product_name || '未记录名称'}</Text>
    <Text>{item.type === 'adjustment' ? item.adjustment ?? item.quantity : item.quantity}{item.unit || ''}</Text>
    <Text>{formatMoney(item.amount || 0)}</Text>
  </View>;
});



export default function PrintCenterPage() {
  const { params } = useRouter();
  const transactionId = params.transaction_id;
  const [mode, setMode] = useState<'document' | 'ledger'>('document');
  const [selectedDocument, setSelectedDocument] = useState<PrintDocument>();
  const [selectedId, setSelectedId] = useState('');
  const [documentLoading, setDocumentLoading] = useState(false);
  const [documentError, setDocumentError] = useState('');
  const [keyword, setKeyword] = useState('');
  const documentSequence = useRef(0);
  const selectedRef = useRef('');
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

  const loadDocument = useCallback(async (id: string, known?: Transaction) => {
    const current = ++documentSequence.current;
    setSelectedDocument(undefined); setDocumentError(''); setSelectedId(id); selectedRef.current = id;
    if (!id) { setDocumentLoading(false); return; }
    setDocumentLoading(true);
    try {
      // Re-read complete records: the list page may end in the middle of an outbound document.
      const records = await getTransactions({ type: known?.type, customer_id: known?.type === 'out' ? known.customer_id ?? undefined : undefined, include_voided: true });
      if (current !== documentSequence.current) return;
      const first = records.find(item => item.id === Number(id));
      if (!first) throw new Error('单据不存在或已删除，请刷新列表后重新选择');
      const key = transactionPrintKey(first);
      setSelectedDocument(documentFromTransactions(records.filter(item => transactionPrintKey(item) === key)));
    } catch (error) {
      if (current === documentSequence.current) setDocumentError(error instanceof Error ? error.message : '读取单据失败，请重试');
    } finally { if (current === documentSequence.current) setDocumentLoading(false); }
  }, []);

  const refresh = useCallback(() => { void loadPage(1); if (selectedRef.current) void loadDocument(selectedRef.current); }, [loadPage, loadDocument]);
  useSharedRefresh(refresh);

  useEffect(() => {
    void loadPage(1);
    if (transactionId && /^\d+$/.test(transactionId)) void loadDocument(transactionId);
    return () => { sequence.current += 1; documentSequence.current += 1; };
  }, [loadPage, loadDocument, transactionId]);

  const documents = useMemo(() => {
    const groups = new Map<string, Transaction>();
    list.filter(item => item.type !== 'adjustment' && !item.voided_at).forEach(item => { const key = transactionPrintKey(item); if (!groups.has(key)) groups.set(key, item); });
    return [...groups.values()];
  }, [list]);
  const documentOptions = documents.filter(item => `${item.outbound_no || item.id} ${item.customer_name || item.supplier_name || ''} ${item.product_name || ''}`.toLowerCase().includes(keyword.toLowerCase()));

  useEffect(() => {
    if (typeof window === 'undefined' || typeof document === 'undefined') return;
    const beforePrint = () => {
      if (mode !== 'ledger') return;
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
  }, [mode]);

  const print = () => {
    if (typeof window !== 'undefined' && typeof window.print === 'function') window.print();
    else Taro.showToast({ title: '请在电脑浏览器打开打印', icon: 'none' });
  };
  return (
    <ScrollView scrollY className={styles.page}>
      <View className={styles.toolbar}>
        <View className={styles.heading}><button data-print-control="button" type='button' aria-label='返回' className={styles.back} onClick={() => { if (Taro.getCurrentPages().length > 1) Taro.navigateBack(); else Taro.switchTab({ url: '/pages/home/index' }); }}>‹</button><Text className={styles.title}>打印中心</Text></View>
        <button data-print-control="button" type='button' className={styles.refresh} disabled={loading || documentLoading} onClick={refresh}>刷新单据</button>
      </View>
      <div className={styles.tabs}><button data-print-control="button" type='button' aria-pressed={mode === 'document'} onClick={() => setMode('document')}>针式单据</button><button data-print-control="button" type='button' aria-pressed={mode === 'ledger'} onClick={() => setMode('ledger')}>流水报表</button></div>
      {mode === 'document' ? <View className={styles.needle}>
        <div className={styles.selection}><div><strong>选择要打印的单据</strong><span>出库按单号合并明细；入库按单条凭证打印。</span></div><input data-print-control="input" aria-label='搜索已加载单据' placeholder='搜索已加载的单号、单位或商品' defaultValue={keyword} onInput={event => setKeyword(event.currentTarget.value)} /><select data-print-control="select" aria-label='选择打印单据' value={selectedId} onChange={event => { const id = event.target.value; void loadDocument(id, list.find(item => item.id === Number(id))); }}><option value=''>测试样张 · 先校准纸张</option>{selectedId && !documentOptions.some(item => String(item.id) === selectedId) && <option value={selectedId}>{selectedDocument ? `${selectedDocument.number} · ${selectedDocument.party}` : `所选流水 #${selectedId}`}</option>}{documentOptions.map(item => <option key={item.id} value={item.id}>{item.type === 'out' ? '出库单' : '入库凭证'} · {item.outbound_no || `#${item.id}`} · {item.customer_name || item.supplier_name || '未关联单位'} · {formatTime(item.created_at)}</option>)}</select></div>
        <Text className={styles.hint}>{loading ? '正在加载单据列表…' : `已加载 ${list.length} 条流水中的 ${documents.length} 张单据${hasMore ? '，更早单据可继续加载。' : '。'}`}</Text>
        {!loading && (hasMore || loadError) && <button data-print-control="button" className={styles.moreBtn} type='button' onClick={() => void loadPage(list.length === 0 ? 1 : page + 1)}>{loadError ? '加载失败，点击重试' : '加载更早单据'}</button>}
        {documentError && <div className={styles.error} role='alert'>{documentError}<button data-print-control="button" type='button' onClick={() => void loadDocument(selectedId)}>重试读取单据</button></div>}
        <DotMatrixPrint document={selectedDocument} loading={documentLoading} blocked={!!documentError} />
      </View> : <View>
        <View className={styles.ledgerActions}><Text className={styles.hint}>按时间倒序加载；流水报表仅打印已加载内容。</Text><button data-print-control="button" type='button' className={styles.printBtn} disabled={loading || !list.length} onClick={print}>打印当前流水</button></View>
        <View className={styles.sheet}>
        <Text className={styles.sheetTitle}>出入库流水（已加载 {list.length} 条）</Text>
        {list.length === 0 && !loading ? <Text>暂无流水</Text> : list.map(item => <PrintTransactionRow key={item.id} item={item} />)}
        {loading && <Text className={styles.hint}>正在加载…</Text>}
        {!loading && hasMore && <View className={styles.moreBtn} onClick={() => void loadPage(list.length === 0 ? 1 : page + 1)}>{loadError ? '加载失败，点击重试' : '加载更多流水'}</View>}
        {!loading && !hasMore && list.length > 0 && <Text className={styles.endHint}>已显示全部流水</Text>}
      </View>
      </View>}
    </ScrollView>
  );
}
