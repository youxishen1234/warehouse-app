import type { Product, Transaction, Stats, ProductForm, Customer, Supplier, CustomerForm, CustomerOrder, Stocktake, StocktakeForm, LedgerType, LedgerEntry, DeliveryNote, OrderStatusEvent, PageResult, BackupExport } from '@/types';
import type { SORT_FIELDS } from '../../backend/list-sort';
import { request } from './request';

export type { LedgerType, LedgerEntry, DeliveryNote, OrderStatusEvent } from '@/types';
export type ListOrder = 'asc' | 'desc';
export type SortQuery<Resource extends keyof typeof SORT_FIELDS> = { sort?: keyof (typeof SORT_FIELDS)[Resource]; order?: ListOrder };
export type PageQuery = { page: number; page_size: number };

const queryString = (params: object) => Object.entries(params)
  .filter(([, value]) => value !== undefined && value !== null && value !== '')
  .map(([key, value]) => `${key}=${encodeURIComponent(String(value))}`)
  .join('&');
const getPage = <T,>(url: string, params: PageQuery & object) =>
  request<PageResult<T>>({ url: `${url}?${queryString(params)}` });

// 统计
export const getStats = () => request<Stats>({ url: '/api/stats' });

// 商品
export const getProducts = (keyword?: string) =>
  request<Product[]>({ url: `/api/products${keyword ? `?keyword=${encodeURIComponent(keyword)}` : ''}` });
export const getProductsPage = (params: PageQuery & SortQuery<'products'> & { keyword?: string }) => getPage<Product>('/api/products', params);

export const getProduct = (id: number) =>
  request<Product>({ url: `/api/products/${id}` });

export const addProduct = (data: ProductForm) =>
  request<Product>({ url: '/api/products', method: 'POST', data });

export const updateProduct = (id: number, data: Partial<ProductForm>) =>
  request<Product>({ url: `/api/products/${id}`, method: 'PUT', data });

export const deleteProduct = (id: number) =>
  request<{ id: number }>({ url: `/api/products/${id}`, method: 'DELETE' });

// 客户
export const getCustomers = (keyword?: string) =>
  request<Customer[]>({ url: `/api/customers${keyword ? `?keyword=${encodeURIComponent(keyword)}` : ''}` });
export const getCustomersPage = (params: PageQuery & SortQuery<'customers'> & { keyword?: string }) => getPage<Customer>('/api/customers', params);

export const getCustomer = (id: number) =>
  request<Customer>({ url: `/api/customers/${id}` });

export const addCustomer = (data: CustomerForm) =>
  request<Customer>({ url: '/api/customers', method: 'POST', data });

export const updateCustomer = (id: number, data: Partial<CustomerForm>) =>
  request<Customer>({ url: `/api/customers/${id}`, method: 'PUT', data });

export const deleteCustomer = (id: number) =>
  request<{ id: number }>({ url: `/api/customers/${id}`, method: 'DELETE' });

export const getSuppliers = (keyword?: string) => request<Supplier[]>({ url: `/api/suppliers?keyword=${encodeURIComponent(keyword || '')}` });
export const getSuppliersPage = (params: PageQuery & SortQuery<'suppliers'> & { keyword?: string }) => getPage<Supplier>('/api/suppliers', params);
export const getSupplier = (id: number) => request<Supplier>({ url: `/api/suppliers/${id}` });
export const addSupplier = (data: CustomerForm) => request<Supplier>({ url: '/api/suppliers', method: 'POST', data });
export const updateSupplier = (id: number, data: Partial<CustomerForm>) => request<Supplier>({ url: `/api/suppliers/${id}`, method: 'PUT', data });
export const deleteSupplier = (id: number) => request<{ id: number }>({ url: `/api/suppliers/${id}`, method: 'DELETE' });

// 出入库（customer_id 关联客户，联动客户管理）
export const stockIn = (product_id: number, quantity: number, operator = '', remark = '', supplier_id?: number | null, details: Record<string, unknown> = {}) =>
  request<{ product: Product; transaction: Transaction }>({
    url: '/api/stock/in', method: 'POST',
    data: { product_id, quantity, operator, remark, supplier_id: supplier_id || null, ...details }
  });

export const stockOut = (product_id: number, quantity: number, operator = '', remark = '', customer_id?: number | null, details: Record<string, unknown> = {}) =>
  request<{ product: Product; transaction: Transaction }>({
    url: '/api/stock/out', method: 'POST',
    data: { product_id, quantity, operator, remark, customer_id: customer_id || null, ...details }
  });
export type StockOutLine = { product_id: number; quantity: number; specification?: string; material?: string; unit?: string; unit_price?: number; remark?: string };
export const stockOutBatch = (lines: StockOutLine[], operator = '', remark = '', customer_id?: number | null) =>
  request<{ transactions: Array<{ product: Product; transaction: Transaction }> }>({ url: '/api/stock/out/batch', method: 'POST', data: { lines, operator, remark, customer_id: customer_id || null } });

export const syncUpload = (payload: { action: string; type?: string; id?: number; product_id?: number; quantity?: number; customer_id?: number | null; supplier_id?: number | null; remark?: string; operator?: string }) =>
  request<{ ok: boolean }>({ url: '/api/sync/upload', method: 'POST', data: payload });

// 记录
export const deleteTransaction = (id: number) =>
  request<{ id: number; product_id: number; type: 'in' | 'out'; quantity: number }>({ url: `/api/transactions/${id}`, method: 'DELETE' });

type TransactionFilters = SortQuery<'transactions'> & { type?: string; keyword?: string; customer_id?: number | string; supplier_id?: number | string; from?: number; to?: number; include_voided?: boolean };
export const getTransactions = (params?: TransactionFilters) => {
  const qs = params ? Object.entries(params)
    .filter(([, v]) => v !== undefined && v !== null && v !== '')
    .map(([k, v]) => `${k}=${encodeURIComponent(String(v))}`)
    .join('&') : '';
  return request<Transaction[]>({ url: `/api/transactions${qs ? `?${qs}` : ''}` });
};
export const getTransactionsPage = (params: PageQuery & TransactionFilters) => getPage<Transaction>('/api/transactions', params);

type LedgerFilters = SortQuery<'ledger'> & { type?: LedgerType; keyword?: string; from?: number; to?: number; include_voided?: boolean };
export const getLedger = (params?: LedgerFilters) => {
  const qs = params ? queryString(params) : '';
  return request<LedgerEntry[]>({ url: `/api/ledger${qs ? `?${qs}` : ''}` });
};
export const getLedgerPage = (params: PageQuery & LedgerFilters) => getPage<LedgerEntry>('/api/ledger', params);
export const addLedger = (data: Omit<LedgerEntry, 'id'|'created_at'>) => request<LedgerEntry>({ url: '/api/ledger', method: 'POST', data });
export const deleteLedger = (id: number) => request<LedgerEntry>({ url: `/api/ledger/${id}`, method: 'DELETE' });
export const addStocktake = (data: StocktakeForm) => request<{ product: Product; stocktake: Stocktake }>({ url: '/api/stocktake', method: 'POST', data });
export const getStocktakes = (product_id?: number) => request<Stocktake[]>({ url: `/api/stocktakes${product_id ? `?product_id=${product_id}` : ''}` });
export const getStocktakesPage = (params: PageQuery & SortQuery<'stocktakes'> & { product_id?: number }) => getPage<Stocktake>('/api/stocktakes', params);
export const getDeliveryNotes = () => request<DeliveryNote[]>({ url: '/api/delivery-notes' });
export const getDeliveryNotesPage = (params: PageQuery & SortQuery<'delivery_notes'>) => getPage<DeliveryNote>('/api/delivery-notes', params);
export const addDeliveryNote = (data: Omit<DeliveryNote, 'id'|'created_at'|'total_square_meters'|'total_amount'> & { operator?: string }) => request<DeliveryNote>({ url: '/api/delivery-notes', method: 'POST', data });
export const deliveryNoteCsvUrl = (id: number) => `/api/delivery-notes/${id}.csv`;
export const voidDeliveryNote = (id: number) => request<DeliveryNote>({ url: `/api/delivery-notes/${id}`, method: 'DELETE' });
export const getBackup = () => request<BackupExport>({ url: '/api/backup' });
// File contents are untrusted until the backend validates the complete dataset.
export const restoreBackup = (data: unknown) => request<Stats>({ url: '/api/backup', method: 'POST', data: { data } });
export const uploadProductImage = (id: number, data: string) => request<Product>({ url: `/api/products/${id}/image`, method: 'POST', data: { data } });
export type OrderFilters = SortQuery<'orders'> & { status?: CustomerOrder['status'] };
export const getOrders = (params?: OrderFilters) => {
  const query = params ? queryString(params) : '';
  return request<CustomerOrder[]>({ url: `/api/orders${query ? `?${query}` : ''}` });
};
export const getOrdersPage = (params: PageQuery & OrderFilters) => getPage<CustomerOrder>('/api/orders', params);
export const addOrder = (data: Partial<CustomerOrder>) => request<CustomerOrder>({ url: '/api/orders', method: 'POST', data });
export const updateOrder = (id:number, data: Partial<CustomerOrder>) => request<CustomerOrder>({ url: `/api/orders/${id}`, method:'PUT', data });
export const getOrderEvents = (id: number) => request<OrderStatusEvent[]>({ url: `/api/orders/${id}/events` });
export const getOrderEventsPage = (id: number, params: PageQuery & SortQuery<'order_events'>) => getPage<OrderStatusEvent>(`/api/orders/${id}/events`, params);
