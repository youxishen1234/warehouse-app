import type { Customer } from '@/types';
import type { DimensionCustomer } from '@/services/customer-dimensions';

export type CustomerSpecView = {
  key: string;
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
const normalizeSpecification = (value: unknown) => specText(value)
  .replace(/\s*(?:[×xX*＊✕]|乘)\s*/g, '×');
export const specificationSearchText = (value: unknown) =>
  normalizeSpecification(value).toLocaleLowerCase().replace(/\s+/g, '');
const specBaseKey = (spec: Pick<CustomerSpecView, 'goods' | 'specification' | 'material' | 'unit' | 'kind'>) =>
  JSON.stringify([specComparable(spec.goods), specificationSearchText(spec.specification), specComparable(spec.material), specComparable(spec.unit), spec.kind]);
const fallbackGoods = (kind: CustomerSpecView['kind']) => kind === '纸板' ? '纸板规格' : '纸箱规格';

function customerSpecs(account: Customer | null, dimension: DimensionCustomer | undefined): CustomerSpecView[] {
  const rows: CustomerSpecView[] = [];
  const dimensionBases = new Set<string>();
  const quoteKeys = new Set<string>();
  for (const spec of account?.specs || []) {
    if (!spec || !specText(spec.specification)) continue;
    const row: CustomerSpecView = {
      key: `quote:${account!.id}:${spec.id}`,
      goods: specText(spec.goods) || fallbackGoods('成品'),
      specification: normalizeSpecification(spec.specification),
      material: specText(spec.material),
      unit: specText(spec.unit) || '个',
      price: Number.isFinite(Number(spec.price)) && Number(spec.price) >= 0 ? Number(spec.price) : null,
      kind: '成品'
    };
    const base = specBaseKey(row);
    const key = `${base}:${row.price ?? 'none'}`;
    dimensionBases.add(base);
    if (quoteKeys.has(key)) continue;
    quoteKeys.add(key);
    rows.push(row);
  }
  const dimensionKeys = new Set<string>();
  for (const spec of dimension?.specs || []) {
    if (!spec || !specText(spec.size)) continue;
    const unit = specText(spec.sizeUnit);
    const specification = normalizeSpecification(specText(spec.size).toLocaleLowerCase().endsWith(unit.toLocaleLowerCase())
      ? spec.size
      : `${spec.size}${unit ? ` ${unit}` : ''}`);
    const kind = spec.kind === '纸板' ? '纸板' : '成品';
    const row: CustomerSpecView = {
      key: `dimension:${dimension!.id}:${spec.id}`,
      goods: specText(spec.goods) || fallbackGoods(kind),
      specification,
      material: specText(spec.material),
      unit: specText(spec.unit) || '个',
      price: null,
      kind
    };
    const base = specBaseKey(row);
    if (dimensionBases.has(base) || dimensionKeys.has(base)) continue;
    dimensionKeys.add(base);
    rows.push(row);
  }
  return rows;
}

export function buildCustomerManagementRows(
  customers: Customer[],
  dimensions: DimensionCustomer[],
  knownInactiveNames: string[] = []
): CustomerManagementRow[] {
  const dimensionGroups = new Map<string, { name: string; customers: DimensionCustomer[] }>();
  for (const dimension of dimensions) {
    const key = nameComparable(dimension.name);
    if (!key) continue;
    const group = dimensionGroups.get(key) || { name: specText(dimension.name), customers: [] };
    group.customers.push(dimension);
    dimensionGroups.set(key, group);
  }
  const activeNameCounts = new Map<string, number>();
  const inactiveNames = new Set(knownInactiveNames.map(nameComparable).filter(Boolean));
  for (const account of customers) {
    const key = nameComparable(account.name);
    if (!key) continue;
    if (account.deleted_at) inactiveNames.add(key);
    else activeNameCounts.set(key, (activeNameCounts.get(key) || 0) + 1);
  }
  const usedDimensions = new Set<string>();
  const rows: CustomerManagementRow[] = [];
  for (const account of customers.filter(customer => !customer.deleted_at)) {
    const key = nameComparable(account.name);
    const dimensionGroup = dimensionGroups.get(key);
    if (dimensionGroup) usedDimensions.add(key);
    const canLinkDimensions = activeNameCounts.get(key) === 1;
    const specs = customerSpecs(account, canLinkDimensions && dimensionGroup?.customers.length === 1 ? dimensionGroup.customers[0] : undefined);
    if (canLinkDimensions && dimensionGroup?.customers.length !== 1) {
      const extraSpecs = dimensionGroup?.customers.flatMap(dimension => customerSpecs(null, dimension)) || [];
      const existing = new Set(specs.map(specBaseKey));
      for (const spec of extraSpecs) if (!existing.has(specBaseKey(spec))) { specs.push(spec); existing.add(specBaseKey(spec)); }
    }
    rows.push({
      key: `customer:${account.id}`,
      name: account.name,
      account,
      specs,
      searchText: specificationSearchText([account.name, account.contact, account.phone, ...specs.flatMap(spec => [spec.goods, spec.specification, spec.material, spec.unit])].join(' '))
    });
  }
  let virtualIndex = 0;
  for (const [key, group] of dimensionGroups) {
    if (inactiveNames.has(key) || usedDimensions.has(key)) continue;
    const merged: CustomerSpecView[] = [];
    const seen = new Set<string>();
    for (const dimension of group.customers) {
      for (const spec of customerSpecs(null, dimension)) {
        const base = specBaseKey(spec);
        if (seen.has(base)) continue;
        seen.add(base);
        merged.push(spec);
      }
    }
    rows.push({
      key: `dimension:${++virtualIndex}`,
      name: group.name,
      account: null,
      specs: merged,
      searchText: specificationSearchText([group.name, ...merged.flatMap(spec => [spec.goods, spec.specification, spec.material, spec.unit])].join(' '))
    });
  }
  return rows;
}
