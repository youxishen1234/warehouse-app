import Taro from '@tarojs/taro';

const KEY = 'warehouse_custom_copy_v1';
export const COPY_DEFAULTS: Record<string, string> = {
  appName: '曙光库存',
  homeTitle: '曙光库存',
  inbound: '入库',
  outbound: '出库',
  inventory: '库存查询',
  products: '商品管理',
  customers: '客户管理',
  suppliers: '供应商管理',
  records: '出入库记录',
  ledger: '账本流水',
  orders: '客户订单',
  cartonCalculator: '纸箱尺寸换算',
  addProduct: '新增商品',
  confirmInbound: '确认入库',
  confirmOutbound: '确认出库'
};

export function getCopy(key: string): string { try { return String(Taro.getStorageSync(KEY)?.[key] || COPY_DEFAULTS[key] || key); } catch { return COPY_DEFAULTS[key] || key; } }
export function getAllCopy(): Record<string, string> { try { return { ...COPY_DEFAULTS, ...(Taro.getStorageSync(KEY) || {}) }; } catch { return { ...COPY_DEFAULTS }; } }
export function saveCopy(values: Record<string, string>) { Taro.setStorageSync(KEY, { ...getAllCopy(), ...values }); if (typeof window !== 'undefined') window.dispatchEvent(new CustomEvent('warehouse-copy-change')); }
export function watchCopy(fn: () => void): () => void { if (typeof window === 'undefined') return () => {}; const handler = () => fn(); window.addEventListener('warehouse-copy-change', handler); return () => window.removeEventListener('warehouse-copy-change', handler); }
