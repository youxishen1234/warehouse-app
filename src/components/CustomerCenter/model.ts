import type { Customer, CustomerSpec } from '@/types';
import type { DimensionCustomer } from '@/services/customer-dimensions';

export type CustomerSpecView = {
  key: string;
  quoteId?: string;
  record?: CustomerSpec;
  source?: { customerId: string; specId: string };
  goods: string;
  specification: string;
  material: string;
  unit: string;
  price: number | null;
  kind: '成品' | '纸板';
};

export type CustomerManagementRow = {
  key: string;
  name: string;
  account: Customer | null;
  specs: CustomerSpecView[];
  searchText: string;
};

export const MAX_VISIBLE_CUSTOMER_SPECS = 3;
const specText = (value: unknown) => String(value ?? '').trim();
const specComparable = (value: unknown) => specText(value).replace(/\s+/g, ' ').toLocaleLowerCase();
const nameComparable = (value: unknown) => specText(value).replace(/\s+/g, ' ').toLocaleLowerCase();
const normalizeSpecification = (value: unknown) => specText(value).replace(/\s*(?:[×xX*＊✕]|乘)\s*/g, '×');
export const specificationSearchText = (value: unknown) =>
  normalizeSpecification(value).toLocaleLowerCase().replace(/\s+/g, '');
const specBaseKey = (spec: Pick<CustomerSpecView, 'goods' | 'specification' | 'material' | 'unit' | 'kind'>) =>
  JSON.stringify([specComparable(spec.goods), specificationSearchText(spec.specification), specComparable(spec.material), specComparable(spec.unit), spec.kind]);
const fallbackGoods = (kind: CustomerSpecView['kind']) => kind === '纸板' ? '纸板规格' : '纸箱规格';
const sourceKey = (customerId: string, specId: string) => JSON.stringify([customerId, specId]);
const expandExponent = (value: number) => {
  const text = String(value);
  const match = text.match(/^(-?)(\d+)(?:\.(\d*))?e([+-]?\d+)$/i);
  if (!match) return text;
  const digits = `${match[2]}${match[3] || ''}`;
  const point = match[2].length + Number(match[4]);
  if (point <= 0) return `${match[1]}0.${'0'.repeat(-point)}${digits}`;
  if (point >= digits.length) return `${match[1]}${digits}${'0'.repeat(point - digits.length)}`;
  return `${match[1]}${digits.slice(0, point)}.${digits.slice(point)}`;
};

export const formatCustomerUnitPrice = (value: number | null) => {
  if (value == null || !Number.isFinite(value)) return '价格未记录';
  const [whole, fraction = ''] = expandExponent(value).split('.');
  return `¥${whole}.${fraction.padEnd(2, '0')}`;
};

export function sameCustomerSpecQuote(left: CustomerSpec, right: CustomerSpec): boolean {
  return left.id === right.id && left.goods === right.goods && left.specification === right.specification
    && (left.material ?? '') === (right.material ?? '') && (left.unit ?? '个') === (right.unit ?? '个')
    && left.price === right.price && (left.kind || '成品') === (right.kind || '成品')
    && (left.dimension_source?.customer_id || '') === (right.dimension_source?.customer_id || '')
    && (left.dimension_source?.spec_id || '') === (right.dimension_source?.spec_id || '');
}

export function appendCustomerSpecQuote(specs: CustomerSpec[], quote: CustomerSpec): { specs: CustomerSpec[]; alreadySaved: boolean } {
  const existing = specs.find(spec => spec.id === quote.id);
  if (existing) {
    if (!sameCustomerSpecQuote(existing, quote)) throw new Error('此规格已变化，草稿已保留；请刷新后重试');
    return { specs, alreadySaved: true };
  }
  return { specs: [...specs, quote], alreadySaved: false };
}

function customerSpecs(account: Customer | null, dimension: DimensionCustomer | undefined, linkedSources = new Set<string>()): CustomerSpecView[] {
  const rows: CustomerSpecView[] = [];
  const dimensionBases = new Set<string>();
  const quoteKeys = new Set<string>();
  for (const spec of account?.specs || []) {
    if (!spec || !specText(spec.specification)) continue;
    const kind = spec.kind === '纸板' ? '纸板' : '成品';
    const row: CustomerSpecView = {
      key: `quote:${account!.id}:${spec.id}`, goods: specText(spec.goods) || fallbackGoods(kind),
      specification: normalizeSpecification(spec.specification), material: specText(spec.material),
      unit: specText(spec.unit) || '个',
      price: typeof spec.price === 'number' && Number.isFinite(spec.price) && spec.price >= 0 ? spec.price : null,
      kind, quoteId: spec.id, record: spec,
      source: spec.dimension_source ? { customerId: spec.dimension_source.customer_id, specId: spec.dimension_source.spec_id } : undefined
    };
    const base = specBaseKey(row); dimensionBases.add(base);
    const key = JSON.stringify([account!.id, spec.id]);
    if (quoteKeys.has(key)) continue;
    quoteKeys.add(key); rows.push(row);
  }
  const dimensions = new Set([
    ...linkedSources,
    ...(account?.specs || []).flatMap(spec => spec.dimension_source ? [sourceKey(spec.dimension_source.customer_id, spec.dimension_source.spec_id)] : [])
  ]);
  const dimensionKeys = new Set<string>();
  for (const spec of dimension?.specs || []) {
    if (!spec || !specText(spec.size) || dimensions.has(sourceKey(dimension!.id, spec.id))) continue;
    const unit = specText(spec.sizeUnit);
    const specification = normalizeSpecification(specText(spec.size).toLocaleLowerCase().endsWith(unit.toLocaleLowerCase())
      ? spec.size : `${spec.size}${unit ? ` ${unit}` : ''}`);
    const kind = spec.kind === '纸板' ? '纸板' : '成品';
    const row: CustomerSpecView = { key: `dimension:${dimension!.id}:${spec.id}`,
      goods: specText(spec.goods) || fallbackGoods(kind), specification, material: specText(spec.material),
      unit: specText(spec.unit) || '个', price: null, kind, source: { customerId: dimension!.id, specId: spec.id } };
    const base = specBaseKey(row);
    if (dimensionBases.has(base) || dimensionKeys.has(base)) continue;
    dimensionKeys.add(base); rows.push(row);
  }
  return rows;
}

export function buildCustomerManagementRows(customers: Customer[], dimensions: DimensionCustomer[], knownInactiveNames: string[] = []): CustomerManagementRow[] {
  const groups = new Map<string, { name: string; customers: DimensionCustomer[] }>();
  for (const dimension of dimensions) {
    const key = nameComparable(dimension.name);
    if (!key) continue;
    const group = groups.get(key) || { name: specText(dimension.name), customers: [] };
    group.customers.push(dimension); groups.set(key, group);
  }
  const counts = new Map<string, number>();
  const inactive = new Set(knownInactiveNames.map(nameComparable).filter(Boolean));
  for (const account of customers) {
    const key = nameComparable(account.name);
    if (!key) continue;
    if (account.deleted_at) inactive.add(key); else counts.set(key, (counts.get(key) || 0) + 1);
  }
  const linked = new Set(customers.filter(customer => !customer.deleted_at).flatMap(customer =>
    (customer.specs || []).flatMap(spec => spec.dimension_source ? [sourceKey(spec.dimension_source.customer_id, spec.dimension_source.spec_id)] : [])));
  const used = new Set<string>();
  const rows: CustomerManagementRow[] = [];
  for (const account of customers.filter(customer => !customer.deleted_at)) {
    const key = nameComparable(account.name), group = groups.get(key);
    if (group) used.add(key);
    const canLink = counts.get(key) === 1;
    const specs = customerSpecs(account, canLink && group?.customers.length === 1 ? group.customers[0] : undefined, linked);
    if (canLink && group?.customers.length !== 1) {
      const existing = new Set(specs.map(specBaseKey));
      for (const dimension of group?.customers || []) for (const spec of customerSpecs(null, dimension, linked)) {
        const base = specBaseKey(spec);
        if (!existing.has(base)) { specs.push(spec); existing.add(base); }
      }
    }
    rows.push({ key: `customer:${account.id}`, name: account.name, account, specs,
      searchText: specificationSearchText([account.name, account.contact, account.phone,
        ...specs.flatMap(spec => [spec.goods, spec.specification, spec.material, spec.unit])].join(' ')) });
  }
  let index = 0;
  for (const [key, group] of groups) {
    if (inactive.has(key) || used.has(key)) continue;
    const merged: CustomerSpecView[] = [], seen = new Set<string>();
    for (const dimension of group.customers) for (const spec of customerSpecs(null, dimension, linked)) {
      const base = specBaseKey(spec);
      if (!seen.has(base)) { seen.add(base); merged.push(spec); }
    }
    if (!merged.length) continue;
    rows.push({ key: `dimension:${++index}`, name: group.name, account: null, specs: merged,
      searchText: specificationSearchText([group.name, ...merged.flatMap(spec => [spec.goods, spec.specification, spec.material, spec.unit])].join(' ')) });
  }
  return rows;
}
