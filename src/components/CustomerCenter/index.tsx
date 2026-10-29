import { useMemo, useState } from 'react';
import { Button, Input, Text, View } from '@tarojs/components';
import type { Customer } from '@/types';
import type { DimensionCustomer } from '@/services/customer-dimensions';
import { session } from '@/services/session';
import { PartySearchPanel } from '@/components/PartySearchPanel';
import QuoteEditor from './QuoteEditor';
import {
  buildCustomerManagementRows, customerSpecMissingFields, formatCustomerUnitPrice, MAX_VISIBLE_CUSTOMER_SPECS, specificationSearchText
} from './model';
import type { CustomerManagementRow, CustomerSpecView } from './model';
import styles from './index.module.scss';

type Props = {
  customers: Customer[];
  dimensionCustomers: DimensionCustomer[];
  inactiveCustomerNames: string[];
  onEditParty: (type: 'customer', id?: number, initialName?: string) => void;
  onViewBills: (id: number) => void;
  onOpenOrders: () => void;
  onSpecsSaved: () => void | Promise<void>;
};

type Filter = 'all' | 'account' | 'draft';

function CustomerSpecs({ customer, specs, expanded, onToggle, editable, onAdd, onEdit }: {
  customer: string;
  specs: CustomerSpecView[];
  expanded: boolean;
  onToggle: () => void;
  editable?: boolean;
  onAdd?: () => void;
  onEdit?: (spec: CustomerSpecView) => void;
}) {
  const visible = expanded ? specs : specs.slice(0, MAX_VISIBLE_CUSTOMER_SPECS);
  return <View className={styles.specs} data-testid={`customer-specs-${customer}`}>
    <View className={styles.specsHeading}>
      <Text className={styles.specsTitle}>常用销售资料 · 货物及价格</Text>
      <View className={styles.specsHeadingActions}><Text className={styles.specsCount}>{specs.length} 种</Text>
        {editable && <Button className={styles.specAdd} data-testid={`customer-spec-add-${customer}`} onClick={onAdd}>新增货物</Button>}</View>
    </View>
    {!specs.length && <Text className={styles.specsEmpty}>还没有记录规格</Text>}
    {visible.map(spec => <View className={styles.specRow} key={spec.key} data-testid={`customer-spec-${customer}-${spec.key}`}>
      <View className={styles.specMain}>
        <View className={styles.specName}>
          <Text>{spec.goods || '货物名称未记录'}</Text>
          <Text className={styles.specKind}>{spec.category}</Text>
        </View>
        <Text className={styles.specSize}>{spec.specification || '尺寸未记录'}</Text>
        <Text className={styles.specMeta}>{spec.material || '材质未记录'} · {spec.unit || '单位未记录'}</Text>
        <Text className={customerSpecMissingFields(spec).length ? styles.incomplete : styles.accountStatus}>
          {customerSpecMissingFields(spec).length ? `资料不完整 · 缺少${customerSpecMissingFields(spec).join('、')}` : '资料完整'}
        </Text>
      </View>
      <View className={styles.specRowActions}><Text className={styles.specPrice}>{spec.price == null ? '价格未记录' : `${formatCustomerUnitPrice(spec.price)}${spec.unit ? `/${spec.unit}` : ''}`}</Text>
        {editable && <Button className={styles.specEdit} aria-label={`编辑规格 ${spec.goods} ${spec.specification}`}
          data-testid={`customer-spec-edit-${spec.key}`} onClick={() => onEdit?.(spec)}>编辑货物</Button>}</View>
    </View>)}
    {specs.length > MAX_VISIBLE_CUSTOMER_SPECS && <Button
      className={styles.specToggle}
      aria-expanded={expanded}
      data-testid={`customer-specs-toggle-${customer}`}
      onClick={onToggle}
    >{expanded ? '收起规格' : `查看全部 ${specs.length} 种规格`}</Button>}
  </View>;
}

function CustomerCard({ row, expanded, onToggle, onEditParty, onViewBills, canEditSpecs, onAddSpec, onEditSpec }: {
  row: CustomerManagementRow;
  expanded: boolean;
  onToggle: () => void;
  onEditParty: Props['onEditParty'];
  onViewBills: Props['onViewBills'];
  canEditSpecs: boolean;
  onAddSpec: (customer: Customer) => void;
  onEditSpec: (customer: Customer, spec: CustomerSpecView) => void;
}) {
  const account = row.account;
  if (!account) return <View className={styles.card} data-testid={`customer-specs-only-${row.key}`} key={row.key}>
    <View className={styles.cardHeading}>
      <View className={styles.customerIdentity}>
        <Text className={styles.customerName}>{row.name}</Text>
        <Text className={styles.draftStatus}>待建立客户资料 · 尺寸本客户</Text>
      </View>
      <Button
        className={styles.primaryAction}
        aria-label={`建立客户资料 ${row.name}`}
        data-testid={`customer-create-from-dimension-${row.key}`}
        onClick={() => onEditParty('customer', undefined, row.name)}
      >建立资料</Button>
    </View>
    <CustomerSpecs customer={row.key} specs={row.specs} expanded={expanded} onToggle={onToggle} />
  </View>;

  return <View className={styles.card} data-testid={`customer-management-card-${account.id}`}>
    <View className={styles.cardHeading}>
      <View className={styles.customerIdentity}>
        <Text className={styles.customerName}>{account.name}</Text>
        <Text className={styles.accountStatus}>客户资料已建立</Text>
      </View>
      <View className={styles.cardActions}>
        <Button
          className={styles.secondaryAction}
          aria-label={`编辑客户 ${account.name}`}
          data-testid={`customer-edit-${account.id}`}
          onClick={() => onEditParty('customer', account.id)}
        >编辑客户</Button>
        <Button
          className={styles.primaryAction}
          aria-label={`查看客户账单 ${account.name}`}
          data-testid={`customer-view-bills-${account.id}`}
          onClick={() => onViewBills(account.id)}
        >查看账单</Button>
      </View>
    </View>
    <View className={styles.contactLine}>
      <Text>联系人：{account.contact || '未记录'}</Text>
      <Text>电话：{account.phone || '未记录'}</Text>
      <Text>地址：{account.address || '未记录'}</Text>
    </View>
    {(!account.contact || !account.phone || !account.address) && <Text className={styles.incomplete}>资料不完整 · 缺少{[!account.contact ? '联系人' : '', !account.phone ? '电话' : '', !account.address ? '地址' : ''].filter(Boolean).join('、')}，可编辑补充</Text>}
    {account.remark && <Text className={styles.remark}>{account.remark}</Text>}
    <CustomerSpecs customer={String(account.id)} specs={row.specs} expanded={expanded} onToggle={onToggle}
      editable={canEditSpecs} onAdd={() => onAddSpec(account)} onEdit={spec => onEditSpec(account, spec)} />
  </View>;
}

export default function CustomerCenter({
  customers, dimensionCustomers, inactiveCustomerNames, onEditParty, onViewBills, onOpenOrders, onSpecsSaved
}: Props) {
  const [query, setQuery] = useState('');
  const [filter, setFilter] = useState<Filter>('all');
  const [selectedId, setSelectedId] = useState<number | null>(null);
  const [expandedSpecs, setExpandedSpecs] = useState<Record<string, boolean>>({});
  const [editingSpec, setEditingSpec] = useState<{ customer: Customer; seed?: CustomerSpecView } | null>(null);
  const [canEditSpecs] = useState(() => {
    const current = session();
    return !!current && current.user.role !== 'viewer' && !current.user.disabled;
  });
  const rows = useMemo(
    () => buildCustomerManagementRows(customers, dimensionCustomers, inactiveCustomerNames),
    [customers, dimensionCustomers, inactiveCustomerNames]
  );
  const accountCount = useMemo(() => rows.filter(row => row.account).length, [rows]);
  const draftCount = useMemo(() => rows.filter(row => !row.account).length, [rows]);
  const visibleRows = useMemo(() => {
    const normalizedQuery = specificationSearchText(query);
    return rows.filter(row =>
      (!selectedId || row.account?.id === selectedId) &&
      (filter === 'all' || (filter === 'account' ? Boolean(row.account) : !row.account)) &&
      (!normalizedQuery || row.searchText.includes(normalizedQuery))
    );
  }, [filter, query, rows, selectedId]);
  const toggleSpecs = (key: string) => setExpandedSpecs(current => ({ ...current, [key]: !current[key] }));

  return <View className={styles.customerCenter} data-testid='customer-center'>
    <Input
      className={styles.search}
      data-testid='customer-center-search'
      aria-label='搜索客户、规格或联系方式'
      placeholder='搜索客户、联系人、电话或货物名称'
      value={query}
      onInput={event => { setQuery(event.detail.value); setSelectedId(null); }}
    />
    <View className={styles.filters} aria-label='客户筛选'>
      {([
        ['all', '全部客户'],
        ['account', '客户档案'],
        ['draft', '待建档']
      ] as const).map(([key, text]) => <Button key={key} aria-pressed={filter === key}
        className={filter === key ? styles.filterActive : styles.filter} data-testid={`customer-filter-${key}`}
        onClick={() => { setFilter(key); setSelectedId(null); }}>{text}{key === 'draft' ? ` ${draftCount}` : key === 'account' ? ` ${accountCount}` : ` ${rows.length}`}</Button>)}
    </View>
    <View className={styles.toolbar}>
      <Button className={styles.primaryAction} data-testid='customer-center-add' onClick={() => onEditParty('customer')}>＋ 新增客户</Button>
      <Button className={styles.ordersAction} data-testid='customer-center-orders' onClick={onOpenOrders}>客户订单</Button>
    </View>
    <PartySearchPanel partyType='customer' parties={customers} selectedId={selectedId} onSelect={party => { setSelectedId(party?.id || null); setQuery(''); setFilter('all'); }} />
    <View className={styles.list} aria-live='polite'>
      {visibleRows.map(row => {
        const specKey = row.account ? String(row.account.id) : row.key;
        return <CustomerCard
          key={row.key}
          row={row}
          expanded={Boolean(expandedSpecs[specKey])}
          onToggle={() => toggleSpecs(specKey)}
          onEditParty={onEditParty}
          onViewBills={onViewBills}
          canEditSpecs={canEditSpecs}
          onAddSpec={customer => setEditingSpec({ customer })}
          onEditSpec={(customer, seed) => setEditingSpec({ customer, seed })}
        />;
      })}
      {!visibleRows.length && <View className={styles.empty} data-testid='customer-center-empty'>
        <Text>{query ? '没有找到匹配客户或规格' : filter === 'draft' ? '没有待建档客户' : '还没有客户资料'}</Text>
        {filter === 'all' && <Text>新增客户后，可在客户资料中查看联系方式和规格。</Text>}
      </View>}
    </View>
    {editingSpec && <QuoteEditor customer={editingSpec.customer} seed={editingSpec.seed}
      onClose={() => setEditingSpec(null)}
      onSaved={async () => { setEditingSpec(null); await onSpecsSaved(); }} />}
  </View>;
}
