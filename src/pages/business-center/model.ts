import type { Customer, CustomerOrder, Product, Transaction } from '@/types';
import type { BoardBatch } from '@/services/boards';
import type { DimensionCustomer, DimensionSpec } from '@/services/customer-dimensions';

export const searchText = (value: unknown) => String(value ?? '').normalize('NFKC').toLowerCase().replace(/[\s×x*]/g, '');
export const matchesQuery = (query: string, values: unknown[]) => !query.trim() || values.some(value => searchText(value).includes(searchText(query)));
export function groupBoards(boards: BoardBatch[]) {
  const groups = new Map<string, BoardBatch[]>();
  for (const board of [...boards].sort((a, b) => b.createdAt - a.createdAt)) {
    const key = board.specKey || board.id;
    groups.set(key, [...(groups.get(key) || []), board]);
  }
  return [...groups].map(([key, batches]) => ({ key, batches, quantity: batches.reduce((sum, b) => sum + b.remainingQty, 0) }));
}
export function boardMatches(query: string, batches: BoardBatch[]) {
  return batches.some(b => matchesQuery(query, [b.id, b.supplier, b.deliveryNo, b.location, b.remark, `${b.boardLength}×${b.boardWidth}`, `${b.cartonLength}×${b.cartonWidth}×${b.cartonHeight}`, `${b.layers}层${b.fluteType}楞`]));
}
export type BusinessCustomer = { key: string; name: string; dimension?: DimensionCustomer; account?: Customer; ambiguous: boolean };
export function mergeCustomers(dimensions: DimensionCustomer[], accounts: Customer[]): BusinessCustomer[] {
  const active = accounts.filter(c => !c.deleted_at);
  const claimed = new Set<number>();
  const rows: BusinessCustomer[] = dimensions.map(dimension => {
    const candidates = active.filter(c => c.name.trim() === dimension.name.trim());
    const ambiguous = candidates.length > 1 || dimensions.filter(c => c.name.trim() === dimension.name.trim()).length > 1;
    const account = !ambiguous && candidates.length === 1 ? candidates[0] : undefined;
    if (account) claimed.add(account.id);
    return { key: `dimension:${dimension.id}`, name: dimension.name, dimension, account, ambiguous };
  });
  for (const account of active) if (!claimed.has(account.id)) rows.push({ key: `account:${account.id}`, name: account.name, account, ambiguous: false });
  return rows;
}
export const specMatches = (query: string, s: DimensionSpec) => matchesQuery(query, [s.goods, `${s.size}${s.sizeUnit}`, s.material, s.kind]);
export const customerMatches = (query: string, c: BusinessCustomer) => matchesQuery(query, [c.name, c.account?.contact, c.account?.phone, c.account?.address]) || c.dimension?.specs.some(s => specMatches(query, s));
export function matchingProducts(spec: DimensionSpec, products: Product[]) {
  if (spec.kind !== '成品') return [];
  return products.filter(p => !p.deleted_at && searchText(p.specification) === searchText(`${spec.size}${spec.sizeUnit}`) && p.unit === spec.unit && (p.material || '').trim() === spec.material.trim() && (!spec.goods || p.name === spec.goods));
}
export function remainingOrder(order: CustomerOrder, transactions: Transaction[]) {
  const shipped = transactions.filter(t => t.type === 'out' && !t.voided_at && t.order_id === order.id).reduce((sum, t) => sum + t.quantity, 0);
  return Math.max(0, Math.round((order.quantity - shipped) * 1e6) / 1e6);
}
export function groupShipments(transactions: Transaction[]) {
  const groups = new Map<string, Transaction[]>();
  for (const tx of [...transactions].sort((a, b) => b.created_at - a.created_at)) {
    if (tx.type !== 'out' || tx.voided_at) continue;
    const key = tx.outbound_no ? `${tx.customer_id ?? tx.customer_name}:${tx.outbound_no}` : `历史-${tx.id}`;
    groups.set(key, [...(groups.get(key) || []), tx]);
  }
  return [...groups].map(([key, rows]) => ({ key, no: rows[0].outbound_no || `历史-${rows[0].id}`, rows }));
}
