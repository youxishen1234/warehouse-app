import { useMemo, useState } from 'react';
import { Button, Input, Text, View } from '@tarojs/components';
import type { Customer } from '@/types';
import type { DimensionCustomer } from '@/services/customer-dimensions';
import { formatMoney } from '@/utils/format';
import {
  buildCustomerManagementRows, MAX_VISIBLE_CUSTOMER_SPECS, specificationSearchText
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
};

type Filter = 'all' | 'account' | 'draft';

function CustomerSpecs({ customer, specs, expanded, onToggle }: {
  customer: string;
  specs: CustomerSpecView[];
  expanded: boolean;
  onToggle: () => void;
}) {
  const visible = expanded ? specs : specs.slice(0, MAX_VISIBLE_CUSTOMER_SPECS);
  return <View className={styles.specs} data-testid={`customer-specs-${customer}`}>
    <View className={styles.specsHeading}>
      <Text className={styles.specsTitle}>常用规格</Text>
      <Text className={styles.specsCount}>{specs.length} 种</Text>
    </View>
    {!specs.length && <Text className={styles.specsEmpty}>还没有记录规格</Text>}
    {visible.map(spec => <View className={styles.specRow} key={spec.key} data-testid={`customer-spec-${customer}-${spec.key}`}>
      <View className={styles.specMain}>
        <View className={styles.specName}>
          <Text>{spec.goods}</Text>
          {spec.kind === '纸板' && <Text className={styles.specKind}>纸板</Text>}
        </View>
        <Text className={styles.specSize}>{spec.specification}</Text>
        <Text className={styles.specMeta}>材质：{spec.material || '未记录'} · 单位：{spec.unit}</Text>
      </View>
      <Text className={styles.specPrice}>{spec.price == null ? '价格未记录' : `${formatMoney(spec.price)}/${spec.unit}`}</Text>
    </View>)}
    {specs.length > MAX_VISIBLE_CUSTOMER_SPECS && <Button
      className={styles.specToggle}
      aria-expanded={expanded}
      data-testid={`customer-specs-toggle-${customer}`}
      onClick={onToggle}
    >{expanded ? '收起规格' : `查看全部 ${specs.length} 种规格`}</Button>}
  </View>;
}

function CustomerCard({ row, expanded, onToggle, onEditParty, onViewBills }: {
  row: CustomerManagementRow;
  expanded: boolean;
  onToggle: () => void;
  onEditParty: Props['onEditParty'];
  onViewBills: Props['onViewBills'];
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
        >编辑</Button>
        <Button
          className={styles.primaryAction}
          aria-label={`查看客户账单 ${account.name}`}
          data-testid={`customer-view-bills-${account.id}`}
          onClick={() => onViewBills(account.id)}
        >查看账单</Button>
      </View>
    </View>
    {(account.contact || account.phone || account.address) && <View className={styles.contactLine}>
      {account.contact && <Text>联系人：{account.contact}</Text>}
      {account.phone && <Text>电话：{account.phone}</Text>}
      {account.address && <Text>地址：{account.address}</Text>}
    </View>}
    {account.remark && <Text className={styles.remark}>{account.remark}</Text>}
    <CustomerSpecs customer={String(account.id)} specs={row.specs} expanded={expanded} onToggle={onToggle} />
  </View>;
}

export default function CustomerCenter({
  customers, dimensionCustomers, inactiveCustomerNames, onEditParty, onViewBills, onOpenOrders
}: Props) {
  const [query, setQuery] = useState('');
  const [filter, setFilter] = useState<Filter>('all');
  const [expandedSpecs, setExpandedSpecs] = useState<Record<string, boolean>>({});
  const rows = useMemo(
    () => buildCustomerManagementRows(customers, dimensionCustomers, inactiveCustomerNames),
    [customers, dimensionCustomers, inactiveCustomerNames]
  );
  const accountCount = useMemo(() => rows.filter(row => row.account).length, [rows]);
  const specCount = useMemo(() => rows.reduce((sum, row) => sum + row.specs.length, 0), [rows]);
  const draftCount = useMemo(() => rows.filter(row => !row.account).length, [rows]);
  const visibleRows = useMemo(() => {
    const normalizedQuery = specificationSearchText(query);
    return rows.filter(row =>
      (filter === 'all' || (filter === 'account' ? Boolean(row.account) : !row.account)) &&
      (!normalizedQuery || row.searchText.includes(normalizedQuery))
    );
  }, [filter, query, rows]);
  const toggleSpecs = (key: string) => setExpandedSpecs(current => ({ ...current, [key]: !current[key] }));

  return <View className={styles.customerCenter} data-testid='customer-center'>
    <View className={styles.intro}>
      <View>
        <Text className={styles.eyebrow}>客户资料</Text>
        <Text className={styles.introTitle}>客户与常用规格</Text>
      </View>
    </View>

    <View className={styles.summary} data-testid='customer-summary'>
      <View className={styles.summaryItem}><Text>客户档案</Text><strong>{accountCount}</strong></View>
      <View className={styles.summaryItem}><Text>常用规格</Text><strong>{specCount}</strong></View>
      <View className={styles.summaryItem}><Text>待建档</Text><strong>{draftCount}</strong></View>
    </View>

    <View className={styles.toolbar}>
      <Button className={styles.primaryAction} data-testid='customer-center-add' onClick={() => onEditParty('customer')}>＋ 新增客户</Button>
      <Button className={styles.ordersAction} data-testid='customer-center-orders' onClick={onOpenOrders}>客户订单</Button>
    </View>

    <Input
      className={styles.search}
      data-testid='customer-center-search'
      aria-label='搜索客户、规格或联系方式'
      placeholder='搜索客户、规格、货物、材质或电话'
      value={query}
      onInput={event => setQuery(event.detail.value)}
    />

    <View className={styles.filters} aria-label='客户筛选'>
      {([
        ['all', '全部客户'],
        ['account', '客户档案'],
        ['draft', '待建档']
      ] as const).map(([key, label]) => <Button
        key={key}
        aria-pressed={filter === key}
        className={filter === key ? styles.filterActive : styles.filter}
        data-testid={`customer-filter-${key}`}
        onClick={() => setFilter(key)}
      >{label}{key === 'draft' ? ` ${draftCount}` : key === 'account' ? ` ${accountCount}` : ` ${rows.length}`}</Button>)}
    </View>

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
        />;
      })}
      {!visibleRows.length && <View className={styles.empty} data-testid='customer-center-empty'>
        <Text>{query ? '没有找到匹配客户或规格' : filter === 'draft' ? '没有待建档客户' : '还没有客户资料'}</Text>
        {filter === 'all' && <Text>新增客户后，可在客户资料中查看联系方式和规格。</Text>}
      </View>}
    </View>
  </View>;
}
