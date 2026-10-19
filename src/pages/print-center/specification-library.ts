import type { Customer, Product } from '@/types';
import type { DimensionCustomer } from '@/services/customer-dimensions';
import type { ItemDraft } from './model';
import { normalizeSpecification } from '../../../backend/print-notes';

export type SpecificationOption = {
  id: string; source: 'customer' | 'product' | 'dimension';
  customer_id: number | null; customer_name: string; product_id: number | null;
  name: string; specification: string; material: string; price: string; unit: string;
};
export const MAX_PRINT_ITEMS = 200;
const text = (value: unknown) => String(value ?? '').trim();
const searchText = (value: unknown) => normalizeSpecification(text(value)).toLocaleLowerCase().replace(/\s+/g, '');
const priceText = (value: unknown) => typeof value === 'number' && Number.isFinite(value) && value >= 0 ? String(value) : '';

// Keep dimension units: 40×30×20 cm is not the same size as 40×30×20 mm.
const dimensionText = (size: string, unit: string) => {
  const value = normalizeSpecification(text(size)), suffix = text(unit);
  return normalizeSpecification(suffix && !value.toLowerCase().endsWith(suffix.toLowerCase()) ? `${value} ${suffix}` : value);
};
export function buildSpecificationOptions(customers: Customer[], products: Product[], dimensions: DimensionCustomer[] = []): SpecificationOption[] {
  const active = customers.filter(customer => !customer.deleted_at);
  const options: SpecificationOption[] = [];
  for (const customer of active) {
    for (const spec of customer.specs || []) {
      if (text(spec.unit || '个') !== '个' || !text(spec.specification)) continue;
      options.push({ id: `customer:${customer.id}:${spec.id}`, source: 'customer', customer_id: customer.id, customer_name: customer.name, product_id: null,
        name: text(spec.goods), specification: normalizeSpecification(spec.specification), material: text(spec.material), price: priceText(spec.price), unit: '个' });
    }
  }
  for (const customer of dimensions) {
    const accounts = active.filter(row => text(row.name) === text(customer.name));
    if (!accounts.length && customers.some(row => row.deleted_at && text(row.name) === text(customer.name))) continue;
    for (const spec of customer.specs || []) {
      if (text(spec.unit) !== '个' || !text(spec.size)) continue;
      options.push({ id: `dimension:${customer.id}:${spec.id}`, source: 'dimension', customer_id: accounts.length === 1 ? accounts[0].id : null, customer_name: customer.name, product_id: null,
        name: text(spec.goods), specification: dimensionText(spec.size, spec.sizeUnit), material: text(spec.material), price: '', unit: '个' });
    }
  }
  for (const product of products) {
    if (product.deleted_at || text(product.unit) !== '个' || !text(product.specification)) continue;
    options.push({ id: `product:${product.id}`, source: 'product', customer_id: null, customer_name: '', product_id: product.id,
      name: text(product.name), specification: normalizeSpecification(product.specification), material: text(product.material), price: priceText(product.price), unit: '个' });
  }
  // Do not collapse equal sizes from different customers, materials or inventory IDs.
  const seen = new Set<string>();
  return options.filter(option => {
    const key = JSON.stringify([option.source, option.customer_id, option.customer_name, option.product_id, searchText(option.name), searchText(option.specification), searchText(option.material), option.price]);
    if (seen.has(key)) return false;
    seen.add(key); return true;
  });
}

export function filterSpecificationOptions(options: SpecificationOption[], query: string, customerId?: number, customerName?: string): SpecificationOption[] {
  const tokens = normalizeSpecification(query).toLocaleLowerCase().trim().split(/\s+/).filter(Boolean);
  const name = text(customerName);
  return options.filter(option => {
    if (customerId != null && option.customer_id !== customerId) return false;
    if (customerId == null && name && (option.source === 'product' || text(option.customer_name) !== name)) return false;
    const haystack = searchText([option.name, option.specification, option.material, option.customer_name].join(' '));
    return tokens.every(token => haystack.includes(searchText(token)));
  });
}

const emptyItem = (item: ItemDraft) => item.product_id == null && ![item.name, item.specification, item.quantity, item.price, item.remark].some(value => text(value));
export const availableSpecificationSlots = (items: ItemDraft[]): number => Math.max(0, MAX_PRINT_ITEMS - items.filter(item => !emptyItem(item)).length);

export function specificationAlreadyAdded(items: ItemDraft[], option: SpecificationOption): boolean {
  return items.some(item => {
    if (option.product_id != null && item.product_id === option.product_id) return true;
    if (option.product_id != null && item.product_id != null) return false;
    return searchText(item.name) === searchText(option.name) && searchText(item.specification) === searchText(option.specification)
      && searchText(item.remark) === searchText(option.material);
  });
}

export function addSpecificationOptions(items: ItemDraft[], options: SpecificationOption[], createItem: () => ItemDraft): { items: ItemDraft[]; added: number } {
  const next = items.slice();
  let added = 0;
  for (const option of options) {
    if (specificationAlreadyAdded(next, option)) continue;
    const emptyIndex = next.findIndex(emptyItem);
    if (emptyIndex < 0 && next.length >= MAX_PRINT_ITEMS) throw new Error('每张单据最多添加 200 项，请缩小搜索范围或逐条添加');
    const item = { ...createItem(), product_id: option.product_id, name: option.name, specification: option.specification, price: option.price, remark: option.material };
    if (emptyIndex >= 0) next[emptyIndex] = { ...item, key: next[emptyIndex].key };
    else next.push(item);
    added++;
  }
  return { items: next, added };
}
