import { useCallback, useEffect, useRef, useState } from 'react';
import { getCustomers, getSuppliers, getProducts, getTransactions, getLedger, getDeliveryNotes, getOrders } from '@/services/api';
import { getBoards } from '@/services/boards';
import { getProduction } from '@/services/business-workflow';
import { getCustomerDimensions } from '@/services/customer-dimensions';
import type { DimensionDocument } from '@/services/customer-dimensions';

const sources = {
  boards: getBoards, products: () => getProducts(), customers: getCustomers, suppliers: getSuppliers,
  transactions: () => getTransactions(), ledger: () => getLedger(), deliveryNotes: getDeliveryNotes,
  production: getProduction, orders: () => getOrders(), customerDimensions: getCustomerDimensions
};
export type WorkbenchSource = keyof typeof sources;
type WorkbenchData = { [Key in WorkbenchSource]: Awaited<ReturnType<(typeof sources)[Key]>> };
type SourceState = Record<WorkbenchSource, { loading: boolean; error: string }>;
const labels: Record<WorkbenchSource, string> = {
  boards: '纸板库存', products: '商品库存', customers: '客户资料', suppliers: '供货商资料',
  transactions: '出入库记录', ledger: '账单记录', deliveryNotes: '送货单', production: '生产记录', orders: '订单', customerDimensions: '尺寸资料'
};
const keys = Object.keys(sources) as WorkbenchSource[];
const emptyDimensions: DimensionDocument = {
  schemaVersion: 1, revision: 0, customers: [], inactiveCustomerNames: [],
  theme: { title: '客户尺寸本', accent: '#468cfb', bg: '#101319', card: '#202630' }
};
export const emptyWorkbenchData: WorkbenchData = {
  boards: [], products: [], customers: [], suppliers: [], transactions: [], ledger: [],
  deliveryNotes: [], production: [], orders: [], customerDimensions: emptyDimensions
};
const initialSources = Object.fromEntries(keys.map(key => [key, { loading: true, error: '' }])) as SourceState;

// Each request publishes its own result. A slow or failed API cannot hold the
// shortcuts, summary or results from other sections behind a shared promise.
export function useWorkbenchData() {
  const [data, setData] = useState<WorkbenchData>(emptyWorkbenchData);
  const [state, setState] = useState<SourceState>(initialSources);
  const sequence = useRef(0), mounted = useRef(true);
  const reload = useCallback(async () => {
    const current = ++sequence.current;
    setState(previous => Object.fromEntries(keys.map(key => [key, { ...previous[key], loading: true, error: '' }])) as SourceState);
    await Promise.all(keys.map(async key => {
      try {
        let result = await sources[key]();
        if (key === 'customerDimensions') {
          const document = result as DimensionDocument;
          if (!Array.isArray(document?.customers)) throw new Error('尺寸资料格式无效');
          result = { ...document, inactiveCustomerNames: Array.isArray(document.inactiveCustomerNames) ? document.inactiveCustomerNames : [] };
        } else if (!Array.isArray(result)) throw new Error('资料格式无效');
        if (!mounted.current || current !== sequence.current) return;
        setData(previous => ({ ...previous, [key]: result }));
        setState(previous => ({ ...previous, [key]: { loading: false, error: '' } }));
      } catch (error) {
        if (!mounted.current || current !== sequence.current) return;
        setState(previous => ({ ...previous, [key]: { loading: false, error: `${labels[key]}加载失败${error instanceof Error ? `：${error.message}` : ''}` } }));
      }
    }));
  }, []);
  useEffect(() => {
    mounted.current = true;
    void reload();
    return () => { mounted.current = false; sequence.current += 1; };
  }, [reload]);
  return {
    data, sources: state, reload,
    loading: keys.some(key => state[key].loading),
    loadError: keys.map(key => state[key].error).filter(Boolean).join('；')
  };
}
