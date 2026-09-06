// 商品类型
export interface Product {
  id: number;
  name: string;
  category: string;
  unit: string;
  price: number;
  stock: number;
  safety_stock: number;
  created_at: number;
  updated_at: number;
}

// 客户类型
export interface Customer {
  id: number;
  name: string;
  contact: string;
  phone: string;
  address: string;
  remark: string;
  created_at: number;
  updated_at: number;
}

// 出入库记录类型
export interface Transaction {
  id: number;
  product_id: number;
  type: 'in' | 'out';
  quantity: number;
  operator: string;
  remark: string;
  customer_id?: number | null;
  customer_name?: string;
  created_at: number;
}

// 统计数据类型
export interface Stats {
  totalProducts: number;
  totalCustomers?: number;
  totalStock: number;
  totalValue: number;
  lowStock: number;
  todayIn: number;
  todayOut: number;
}

// 客户表单数据
export interface CustomerForm {
  name: string;
  contact: string;
  phone: string;
  address: string;
  remark: string;
}

// API 通用响应
export interface ApiResponse<T> {
  success: boolean;
  data: T;
  message?: string;
}

// 商品表单数据
export interface ProductForm {
  name: string;
  category: string;
  unit: string;
  price: number;
  stock: number;
  safety_stock: number;
}
