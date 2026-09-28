// 商品类型
export interface Product {
  id: number;
  name: string;
  category: string;
  specification?: string;
  material?: string;
  corrugation?: string;
  weight?: number;
  length?: number;
  width?: number;
  layers?: number;
  image_url?: string;
  deleted_at?: number | null;
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
  deleted_at?: number | null;
  created_at: number;
  updated_at: number;
}

// 出入库记录类型
export interface Transaction {
  voided_at?: number;
  adjustment?: number;
  specification?: string;
  material?: string;
  corrugation?: string;
  weight?: number;
  length?: number;
  width?: number;
  layers?: number;
  unit?: string;
  unit_price?: number;
  amount?: number;
  supplier_id?: number | null;
  supplier_name?: string;
  supplier_current_name?: string;
  id: number;
  product_id: number;
  product_name?: string;
  type: 'in' | 'out' | 'adjustment';
  quantity: number;
  operator: string;
  remark: string;
  customer_id?: number | null;
  customer_name?: string;
  customer_current_name?: string;
  created_at: number;
}

// 统计数据类型
export interface Stats {
  totalProducts: number;
  totalCustomers?: number;
  totalSuppliers?: number;
  totalReceivable?: number;
  totalPayable?: number;
  totalStock: number;
  totalStockByUnit?: Record<string, number>;
  totalValue: number;
  lowStock: number;
  todayIn: number;
  todayOut: number;
}

// 客户表单数据
export interface CustomerForm {
  debt?: number;
  payable?: number;
  settlement_remark?: string;
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
  corrugation?: string;
  weight?: number;
  length?: number;
  width?: number;
  layers?: number;
  unit: string;
  price: number;
  stock: number;
  safety_stock: number;
}

export interface Supplier extends Customer {
  payable?: number;
}
export interface CustomerOrder { id:number; order_no:string; customer_id?:number|null; customer_name:string; specification:string; material:string; quantity:number; unit:string; unit_price:number; amount:number; delivery_date:string; status:'待生产'|'生产中'|'已发货'|'已完成'|'已取消'; remark:string; created_at:number; }
export interface Stocktake { id:number; product_id:number; product_name:string; before_stock:number; counted_stock:number; diff:number; counted_at:number; created_at:number; remark:string; }
export interface StocktakeForm { product_id: number; counted_stock: number; counted_at?: string | number; remark?: string; operator?: string; }

export type LedgerType = 'income' | 'expense' | 'receivable' | 'payable' | 'settlement';

export interface LedgerEntry {
  id: number;
  type: LedgerType;
  amount: number;
  remark: string;
  party_id?: number | null;
  party_name?: string;
  party_current_name?: string;
  created_at: number;
}

export interface DeliveryLine {
  product_id?: number | null;
  product_name?: string;
  specification: string;
  unit?: string;
  length?: number;
  width?: number;
  quantity: number;
  unit_price: number;
  delivered_qty: number;
  square_meters?: number;
  amount?: number;
  transaction_id?: number;
}

export interface DeliveryNote {
  id: number;
  date: string;
  work_order_no: string;
  supplier_id?: number | null;
  supplier_name: string;
  driver_phone: string;
  vehicle_no: string;
  freight: number;
  remark: string;
  operator?: string;
  voided_at?: number;
  lines: DeliveryLine[];
  total_square_meters: number;
  total_amount: number;
  created_at: number;
}

export interface OrderStatusEvent {
  id: number;
  order_id: number;
  from: CustomerOrder['status'];
  to: CustomerOrder['status'];
  created_at: number;
}

export interface PageResult<T> {
  items: T[];
  total: number;
  page: number;
  page_size: number;
}

export interface BackupMetadata {
  schemaVersion?: number;
  nextProductId?: number;
  nextCustomerId?: number;
  nextSupplierId?: number;
  nextTransactionId?: number;
  nextLedgerId?: number;
  nextOrderId?: number;
  nextOrderEventId?: number;
  nextStocktakeId?: number;
  nextDeliveryNoteId?: number;
  [key: string]: unknown;
}

// Shape emitted by the current server. Older imported files remain unknown
// until the server validates them before replacing any existing data.
export interface WarehouseBackupData {
  products: Product[];
  customers: Customer[];
  suppliers: Supplier[];
  transactions: Transaction[];
  ledger: LedgerEntry[];
  orders: CustomerOrder[];
  order_events: OrderStatusEvent[];
  stocktakes: Stocktake[];
  delivery_notes: DeliveryNote[];
  _meta?: BackupMetadata;
  _collaboration?: {
    revision: number;
    audit: Array<{ id: number; actor_id: string; actor_name: string; operation: string; time: number; record_id: number | null }>;
    receipts: Record<string, { fingerprint: string; data: unknown; time: number }>;
  };
  [key: string]: unknown;
}

export interface BackupExport {
  exportedAt: string;
  data: WarehouseBackupData;
}
