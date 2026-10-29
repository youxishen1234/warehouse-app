import type { Customer, CustomerOrder, Product, Supplier } from '@/types';

export type OrderAttention = 'overdue' | 'upcoming';
export type HomeTask = {
  id: 'overdue' | 'upcoming' | 'stock' | 'receivable' | 'payable';
  title: string;
  detail: string;
  count: number;
  amount?: number;
};

const dateKey = (date: Date) => `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, '0')}-${String(date.getDate()).padStart(2, '0')}`;
const openOrder = (order: CustomerOrder) => ['待生产', '生产中', '待发货'].includes(order.status);
const positiveBalance = (value: unknown) => typeof value === 'number' && Number.isFinite(value) && value > 0 ? value : 0;

export const isStockWarning = (product: Product) => !product.deleted_at
  && Number(product.stock || 0) <= Math.max(0, Number(product.safety_stock) || 0);

export function attentionOrders(orders: CustomerOrder[], attention: OrderAttention, now = new Date()): CustomerOrder[] {
  const today = dateKey(now), upcoming = new Date(now);
  upcoming.setDate(upcoming.getDate() + 3);
  const end = dateKey(upcoming);
  return orders.filter(order => {
    if (!openOrder(order) || !/^\d{4}-\d{2}-\d{2}$/.test(order.delivery_date || '')) return false;
    return attention === 'overdue' ? order.delivery_date < today : order.delivery_date >= today && order.delivery_date <= end;
  }).sort((a, b) => a.delivery_date.localeCompare(b.delivery_date) || a.id - b.id);
}

export function dashboardTasks(data: { orders: CustomerOrder[]; products: Product[]; customers: Customer[]; suppliers: Supplier[] }, now = new Date()): HomeTask[] {
  const overdue = attentionOrders(data.orders, 'overdue', now), upcoming = attentionOrders(data.orders, 'upcoming', now);
  const stock = data.products.filter(isStockWarning);
  const receivable = data.customers.filter(row => !row.deleted_at && positiveBalance(row.debt));
  const payable = data.suppliers.filter(row => !row.deleted_at && positiveBalance(row.payable));
  const tasks: HomeTask[] = [];
  if (overdue.length) tasks.push({ id: 'overdue', title: `${overdue.length} 笔订单已逾期`, detail: `${overdue[0].customer_name} · 交期 ${overdue[0].delivery_date}`, count: overdue.length });
  if (upcoming.length) tasks.push({ id: 'upcoming', title: `${upcoming.length} 笔订单近期交货`, detail: `未来三天内 · 最早 ${upcoming[0].delivery_date}`, count: upcoming.length });
  if (stock.length) tasks.push({ id: 'stock', title: `${stock.length} 项库存预警`, detail: '查看低于安全库存的商品', count: stock.length });
  if (receivable.length) tasks.push({ id: 'receivable', title: `${receivable.length} 位客户待收款`, detail: '查看客户账单并登记收款', count: receivable.length, amount: Math.round(receivable.reduce((sum, row) => sum + Math.round(positiveBalance(row.debt) * 100), 0)) / 100 });
  if (payable.length) tasks.push({ id: 'payable', title: `${payable.length} 位供货商待付款`, detail: '查看供货商账单并登记付款', count: payable.length, amount: Math.round(payable.reduce((sum, row) => sum + Math.round(positiveBalance(row.payable) * 100), 0)) / 100 });
  return tasks.slice(0, 5);
}
