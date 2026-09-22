// 商品类型
export interface Product {
  id: number;
  name: string;
  category: string;
  specification?: string;
  material?: string;
  image_url?: string;
  unit: string;
  price: number;
  stock: number;
  safety_stock: number;
  created_at: number;
  updated_at: number;
}

// 客户类型
export interface Customer {
  debt?: number;
  payable?: number;
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
  specification?: string;
  material?: string;
  unit?: string;
  unit_price?: number;
  amount?: number;
  supplier_id?: number | null;
  supplier_name?: string;
  id: number;
  product_id: number;
  product_name?: string;
  type: 'in' | 'out' | 'adjustment';
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
  debt?: number;
  payable?: number;
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
  specification?: string;
  material?: string;
  unit: string;
  price: number;
  stock: number;
  safety_stock: number;
}
export interface CustomerOrder { id:number; order_no:string; customer_id?:number|null; customer_name:string; specification:string; material:string; quantity:number; unit:string; unit_price:number; amount:number; delivery_date:string; status:'待生产'|'生产中'|'已发货'|'已完成'; remark:string; created_at:number; }
export interface Stocktake { id:number; product_id:number; product_name:string; before_stock:number; counted_stock:number; diff:number; counted_at:number; created_at:number; remark:string; }
