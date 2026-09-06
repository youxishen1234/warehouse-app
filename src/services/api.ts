import { request } from './request';
import type { Product, Transaction, Stats, ProductForm, Customer, CustomerForm } from '@/types';

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

// 出入库（customer_id 关联客户，联动客户管理）
export const stockIn = (product_id: number, quantity: number, operator = '', remark = '', customer_id?: number | null) =>
  request<{ product: Product; transaction: Transaction }>({
    url: '/api/stock/in', method: 'POST',
    data: { product_id, quantity, operator, remark, customer_id: customer_id || null }
  });

export const stockOut = (product_id: number, quantity: number, operator = '', remark = '', customer_id?: number | null) =>
  request<{ product: Product; transaction: Transaction }>({
    url: '/api/stock/out', method: 'POST',
    data: { product_id, quantity, operator, remark, customer_id: customer_id || null }
  });

// 记录
export const deleteTransaction = (id: number) =>
  request<{ id: number; product_id: number; type: 'in' | 'out'; quantity: number }>({ url: `/api/transactions/${id}`, method: 'DELETE' });

export const getTransactions = (params?: { type?: string; keyword?: string; customer_id?: number | string }) => {
  const qs = params ? Object.entries(params)
    .filter(([, v]) => v !== undefined && v !== null && v !== '')
    .map(([k, v]) => `${k}=${encodeURIComponent(String(v))}`)
    .join('&') : '';
  return request<Transaction[]>({ url: `/api/transactions${qs ? `?${qs}` : ''}` });
};
