import { useMemo, useState } from 'react';
import { Button, Input, Text, View } from '@tarojs/components';
import Taro from '@tarojs/taro';
import type { Customer } from '@/types';
import type { DimensionCustomer } from '@/services/customer-dimensions';
import { session } from '@/services/session';
import QuoteEditor from './QuoteEditor';
import {
  buildCustomerManagementRows, customerSpecMissingFields, formatCustomerUnitPrice, MAX_VISIBLE_CUSTOMER_SPECS, specificationSearchText
} from './model';
import type { CustomerSpecView } from './model';
import styles from './index.module.scss';

type Props = {
  customers: Customer[];
  dimensionCustomers: DimensionCustomer[];
  inactiveCustomerNames: string[];
  onEditParty: (type: 'customer', id?: number, initialName?: string) => void;
  onViewBills: (id: number) => void;
  onOpenOrders: (customerId?: number) => void;
  onSpecsSaved: () => void | Promise<void>;
};

type Filter = 'all' | 'pinned' | 'debt';

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

export default function CustomerCenter({
  customers, dimensionCustomers, inactiveCustomerNames, onEditParty, onViewBills, onOpenOrders, onSpecsSaved
}: Props) {
  const [query, setQuery] = useState('');
  const [filter, setFilter] = useState<Filter>('all');
  const [selectedId, setSelectedId] = useState<number | null>(null);
  const [editingSpec, setEditingSpec] = useState<{ customer: Customer; seed?: CustomerSpecView } | null>(null);
  const [selectedKey, setSelectedKey] = useState('');
  const [detailTab, setDetailTab] = useState<'goods' | 'info'>('goods');
  const [expandedSpecs, setExpandedSpecs] = useState(false);
  const [recentIds] = useState<number[]>(() => {
    const saved = Taro.getStorageSync('party-search-recent-customer');
    return Array.isArray(saved) ? saved : [];
  });
  const [canEditSpecs] = useState(() => {
    const current = session();
    return !!current && current.user.role !== 'viewer' && !current.user.disabled;
  });
  const rows = useMemo(
    () => buildCustomerManagementRows(customers, dimensionCustomers, inactiveCustomerNames),
    [customers, dimensionCustomers, inactiveCustomerNames]
  );
  const visibleRows = useMemo(() => {
    const normalizedQuery = specificationSearchText(query);
    return rows.filter(row =>
      (!selectedId || row.account?.id === selectedId) &&
      (filter === 'all' || (filter === 'pinned' ? recentIds.includes(row.account?.id || 0) : Number(row.account?.debt || 0) > 0)) &&
      (!normalizedQuery || row.searchText.includes(normalizedQuery))
    );
  }, [filter, query, rows, selectedId, recentIds]);

  const selected = rows.find(row => row.key === selectedKey);
  const quoteEditor = editingSpec && <QuoteEditor customer={editingSpec.customer} seed={editingSpec.seed}
    onClose={() => setEditingSpec(null)} onSaved={async () => { setEditingSpec(null); await onSpecsSaved(); }} />;
  if (selected) return <View className={styles.customerCenter} data-testid='customer-center'>
    <Button className={styles.detailBack} onClick={() => setSelectedKey('')}>‹ 全部客户</Button>
    <View className={styles.detailHero}><View><strong>{selected.name}</strong><Button data-testid={selected.account ? `customer-edit-${selected.account.id}` : `customer-create-from-dimension-${selected.key}`} onClick={() => onEditParty('customer', selected.account?.id, selected.name)}>{selected.account ? '编辑资料' : '建立客户资料'}</Button></View>
      <Text>{[selected.account?.contact, selected.account?.phone].filter(Boolean).join(' · ')}</Text><Text>当前待收款</Text><strong>{formatCustomerUnitPrice(Number(selected.account?.debt || 0))}</strong></View>
    <View className={styles.detailTabs}><Button aria-pressed={detailTab === 'goods'} onClick={() => setDetailTab('goods')}>常用货物</Button><Button onClick={() => selected.account ? onViewBills(selected.account.id) : onEditParty('customer', undefined, selected.name)}>往来账单</Button><Button aria-pressed={detailTab === 'info'} onClick={() => setDetailTab('info')}>客户资料</Button></View>
    {detailTab === 'goods' ? <CustomerSpecs customer={selected.account ? String(selected.account.id) : selected.key} specs={selected.specs} expanded={expandedSpecs} onToggle={() => setExpandedSpecs(value => !value)}
      editable={canEditSpecs && Boolean(selected.account)} onAdd={() => selected.account && setEditingSpec({ customer: selected.account })}
      onEdit={spec => selected.account && setEditingSpec({ customer: selected.account, seed: spec })} /> : <View className={styles.detailInfo}>
      {([['客户名称', selected.name], ['联系人', selected.account?.contact], ['联系电话', selected.account?.phone], ['地址', selected.account?.address], ['备注', selected.account?.remark]]).map(([label, value]) => <View key={label}><Text>{label}</Text><Text>{value || '—'}</Text></View>)}
    </View>}
    <View className={styles.detailActions}><Button className={styles.secondaryAction} disabled={!selected.account} onClick={() => selected.account && onViewBills(selected.account.id)}>登记收款</Button><Button className={styles.primaryAction} data-testid='customer-center-orders' onClick={() => onOpenOrders(selected.account?.id)}>＋ 给客户开单</Button></View>
    {quoteEditor}
  </View>;

  return <View className={styles.customerCenter} data-testid='customer-center'>
    <View className={styles.summary}><View className={styles.summaryItem}><Text>全部客户</Text><strong>{rows.length}</strong></View><View className={styles.summaryItem}><Text>待收款客户</Text><strong>{rows.filter(row => Number(row.account?.debt || 0) > 0).length}</strong></View><View className={styles.summaryItem}><Text>待收合计</Text><strong>{formatCustomerUnitPrice(rows.reduce((sum, row) => sum + Number(row.account?.debt || 0), 0))}</strong></View></View>
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
        ['pinned', '常用客户'],
        ['debt', '有待收款']
      ] as const).map(([key, text]) => <Button key={key} aria-pressed={filter === key}
        className={filter === key ? styles.filterActive : styles.filter} data-testid={`customer-filter-${key}`}
        onClick={() => { setFilter(key); setSelectedId(null); }}>{text}</Button>)}
    </View>
    <View className={styles.toolbar}>
      <Button className={styles.primaryAction} data-testid='customer-center-add' onClick={() => onEditParty('customer')}>＋ 新增客户</Button>
    </View>
    <View className={styles.list} aria-live='polite'>
      {visibleRows.map(row => {
        return <Button className={styles.listCard} key={row.key} data-testid={row.account ? `customer-management-card-${row.account.id}` : `customer-specs-only-${row.key}`} onClick={() => { setSelectedKey(row.key); setDetailTab('goods'); setExpandedSpecs(false); }}>
          <View className={styles.listCardTop}><View className={styles.partyAvatar}>{Array.from(row.name)[0]}</View><View className={styles.listCardIdentity}><strong>{row.name}</strong><Text>{[row.account?.contact, row.account?.phone].filter(Boolean).join(' · ')}</Text></View><Text className={styles.listChevron}>›</Text></View>
          <View className={styles.listCardFoot}><Text>常用货物 {row.specs.length} 种</Text><Text>{Number(row.account?.debt || 0) > 0 ? `待收 ${formatCustomerUnitPrice(Number(row.account?.debt))}` : row.account ? '账款已结清' : '待建立客户资料'}</Text></View>
        </Button>;
      })}
      {!visibleRows.length && <View className={styles.empty} data-testid='customer-center-empty'>
        <Text>{query || filter !== 'all' ? '暂无匹配客户' : '暂无客户资料'}</Text>
      </View>}
    </View>
    {quoteEditor}
  </View>;
}
