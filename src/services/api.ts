import { request } from './request';
import type { Product, Transaction, Stats, ProductForm, Customer, CustomerForm, CustomerOrder } from '@/types';

// 统计
export const getStats = () => request<Stats>({ url: '/api/stats' });

// 商品
export const getProducts = (keyword?: string) =>
  request<Product[]>({ url: `/api/products${keyword ? `?keyword=${encodeURIComponent(keyword)}` : ''}` });

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

export const getCustomer = (id: number) =>
  request<Customer>({ url: `/api/customers/${id}` });

export const addCustomer = (data: CustomerForm) =>
  request<Customer>({ url: '/api/customers', method: 'POST', data });

export const updateCustomer = (id: number, data: Partial<CustomerForm>) =>
  request<Customer>({ url: `/api/customers/${id}`, method: 'PUT', data });

export const deleteCustomer = (id: number) =>
  request<{ id: number }>({ url: `/api/customers/${id}`, method: 'DELETE' });

export const getSuppliers = (keyword?: string) => request<Customer[]>({ url: `/api/suppliers?keyword=${encodeURIComponent(keyword || '')}` });
export const getSupplier = (id: number) => request<Customer>({ url: `/api/suppliers/${id}` });
export const addSupplier = (data: CustomerForm) => request<Customer>({ url: '/api/suppliers', method: 'POST', data });
export const updateSupplier = (id: number, data: Partial<CustomerForm>) => request<Customer>({ url: `/api/suppliers/${id}`, method: 'PUT', data });
export const deleteSupplier = (id: number) => request({ url: `/api/suppliers/${id}`, method: 'DELETE' });

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

export const syncUpload = (payload: { action: string; type?: string; id?: number; product_id?: number; quantity?: number; customer_id?: number | null; supplier_id?: number | null; remark?: string; operator?: string }) =>
  request<{ ok: boolean }>({ url: '/api/sync/upload', method: 'POST', data: payload });

// 记录
export const deleteTransaction = (id: number) =>
  request<{ id: number; product_id: number; type: 'in' | 'out'; quantity: number }>({ url: `/api/transactions/${id}`, method: 'DELETE' });

export const getTransactions = (params?: { type?: string; keyword?: string; customer_id?: number | string; supplier_id?: number | string; from?: number; to?: number }) => {
  const qs = params ? Object.entries(params)
    .filter(([, v]) => v !== undefined && v !== null && v !== '')
    .map(([k, v]) => `${k}=${encodeURIComponent(String(v))}`)
    .join('&') : '';
  return request<Transaction[]>({ url: `/api/transactions${qs ? `?${qs}` : ''}` });
};

export type LedgerType = 'income' | 'expense' | 'receivable' | 'payable' | 'settlement';
export interface LedgerEntry { id: number; type: LedgerType; amount: number; remark: string; party_id?: number | null; party_name?: string; created_at: number; }
export const getLedger = (params?: { type?: LedgerType; keyword?: string; from?: number; to?: number }) => {
  const qs = params ? Object.entries(params).filter(([,v]) => v !== undefined && v !== '').map(([k,v]) => `${k}=${encodeURIComponent(String(v))}`).join('&') : '';
  return request<LedgerEntry[]>({ url: `/api/ledger${qs ? `?${qs}` : ''}` });
};
export const addLedger = (data: Omit<LedgerEntry, 'id'|'created_at'>) => request<LedgerEntry>({ url: '/api/ledger', method: 'POST', data });
export const deleteLedger = (id: number) => request<LedgerEntry>({ url: `/api/ledger/${id}`, method: 'DELETE' });
export const addStocktake = (data: { product_id: number; counted_stock: number; counted_at?: string | number; remark?: string; operator?: string }) => request<any>({ url: '/api/stocktake', method: 'POST', data });
export const getStocktakes = (product_id?: number) => request<any[]>({ url: `/api/stocktakes${product_id ? `?product_id=${product_id}` : ''}` });
export type DeliveryLine = { product_id?: number | null; product_name?: string; specification: string; quantity: number; unit_price: number; delivered_qty: number; square_meters?: number; amount?: number; transaction_id?: number; };
export type DeliveryNote = { id:number; date:string; work_order_no:string; supplier_id?:number|null; supplier_name:string; driver_phone:string; vehicle_no:string; freight:number; remark:string; lines:DeliveryLine[]; total_square_meters:number; total_amount:number; created_at:number; };
export const getDeliveryNotes = () => request<DeliveryNote[]>({ url: '/api/delivery-notes' });
export const addDeliveryNote = (data: Omit<DeliveryNote, 'id'|'created_at'|'total_square_meters'|'total_amount'> & { operator?: string }) => request<DeliveryNote>({ url: '/api/delivery-notes', method: 'POST', data });
export const deliveryNoteCsvUrl = (id: number) => `/api/delivery-notes/${id}.csv`;
export const uploadProductImage = (id: number, data: string) => request<Product>({ url: `/api/products/${id}/image`, method: 'POST', data: { data } });
export const getOrders = () => request<CustomerOrder[]>({ url: '/api/orders' });
export const addOrder = (data: Partial<CustomerOrder>) => request<CustomerOrder>({ url: '/api/orders', method: 'POST', data });
export const updateOrder = (id:number, data: Partial<CustomerOrder>) => request<CustomerOrder>({ url: `/api/orders/${id}`, method:'PUT', data });
export type OrderStatusEvent = { id: number; order_id: number; from: CustomerOrder['status']; to: CustomerOrder['status']; created_at: number };
export const getOrderEvents = (id: number) => request<OrderStatusEvent[]>({ url: `/api/orders/${id}/events` });
