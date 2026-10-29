import { useMemo, useState } from 'react';
import { Button, Input, Text, View } from '@tarojs/components';
import Taro from '@tarojs/taro';
import { GoodsCards } from '@/components/PartySearchPanel';
import type { PartyGood } from '@/components/PartySearchPanel';
import type { CustomerSpec, Supplier } from '@/types';
import { session } from '@/services/session';
import QuoteEditor from '@/components/CustomerCenter/QuoteEditor';
import type { CustomerSpecView } from '@/components/CustomerCenter/model';
import styles from '@/components/CustomerCenter/index.module.scss';

type Props = {
  suppliers: Supplier[];
  onEditParty: (type: 'supplier', id?: number) => void;
  onViewBills: (id: number) => void;
  onSpecsSaved: () => void | Promise<void>;
};

const specView = (record: CustomerSpec): CustomerSpecView => ({
  key: record.id, quoteId: record.id, record, goods: record.goods || '', specification: record.specification || '',
  material: record.material || '', unit: record.unit || '', price: record.unitPrice ?? record.price,
  kind: record.kind === '纸板' || record.category === '纸板' ? '纸板' : '成品',
  category: record.category || (record.kind === '纸板' ? '纸板' : '纸箱')
});

export default function SupplierCenter({ suppliers, onEditParty, onViewBills, onSpecsSaved }: Props) {
  const [query, setQuery] = useState('');
  const [selectedId, setSelectedId] = useState<number | null>(null);
  const [filter, setFilter] = useState<'all' | 'pinned' | 'debt'>('all');
  const [recentIds] = useState<number[]>(() => {
    const saved = Taro.getStorageSync('party-search-recent-supplier');
    return Array.isArray(saved) ? saved : [];
  });
  const [editingSpec, setEditingSpec] = useState<{ supplier: Supplier; seed?: CustomerSpecView } | null>(null);
  const currentSession = session();
  const editable = !!currentSession && !currentSession.user.disabled && currentSession.user.role !== 'viewer';
  const visible = useMemo(() => suppliers.filter(supplier => {
    const needle = query.trim().toLocaleLowerCase().replace(/\s+/g, '');
    return !supplier.deleted_at && (!selectedId || supplier.id === selectedId)
      && (filter === 'all' || (filter === 'pinned' ? recentIds.includes(supplier.id) : Number(supplier.payable || 0) > 0))
      && (!needle || [supplier.name, supplier.contact, supplier.phone, ...(supplier.specs || []).map(spec => spec.goods)]
        .join(' ').toLocaleLowerCase().replace(/\s+/g, '').includes(needle));
  }), [suppliers, query, selectedId, filter, recentIds]);
  const editGood = (supplier: Supplier, good: PartyGood) => {
    const record = supplier.specs?.find(spec => spec.id === good.id);
    if (record) setEditingSpec({ supplier, seed: specView(record) });
  };

  return <View className={styles.customerCenter} data-testid='supplier-center'>
    {selectedId ? <Button className={styles.detailBack} onClick={() => setSelectedId(null)}>‹ 全部供货商</Button> : <View className={styles.supplierSummary}><View><Text>合作供货商</Text><strong>{suppliers.filter(row => !row.deleted_at).length}<small>家</small></strong></View><View><Text>待付合计</Text><strong>{suppliers.filter(row => !row.deleted_at).reduce((sum, row) => sum + Number(row.payable || 0), 0).toLocaleString('zh-CN', { style: 'currency', currency: 'CNY' })}</strong></View></View>}
    <Input className={styles.search} value={query} aria-label='搜索供货商、联系人、电话或货物名称'
      placeholder='搜索供货商、联系人、电话或货物名称' onInput={event => { setQuery(event.detail.value); setSelectedId(null); }} />
    <View className={styles.toolbar}><Button className={styles.primaryAction} data-testid='supplier-center-add'
      disabled={!editable} onClick={() => onEditParty('supplier')}>新增供货商</Button></View>
    {!selectedId && <View className={styles.filters}>{([['all', '全部供货商'], ['pinned', '常用'], ['debt', '待付款']] as const).map(([value, label]) => <Button key={value} className={filter === value ? styles.filterActive : styles.filter} aria-pressed={filter === value} onClick={() => setFilter(value)}>{label}</Button>)}</View>}
    <View className={styles.list} aria-live='polite'>
      {visible.map(supplier => selectedId !== supplier.id ? <Button className={styles.listCard} key={supplier.id} data-testid={`supplier-management-card-${supplier.id}`} onClick={() => setSelectedId(supplier.id)}>
        <View className={styles.listCardTop}><View className={styles.partyAvatar}>{Array.from(supplier.name)[0]}</View><View className={styles.listCardIdentity}><strong>{supplier.name}</strong><Text>{[supplier.contact, supplier.phone].filter(Boolean).join(' · ')}</Text></View><Text className={styles.listChevron}>›</Text></View>
        <View className={styles.listCardFoot}><Text>常购规格 {(supplier.specs || []).length} 种</Text><Text>待付 {Number(supplier.payable || 0).toLocaleString('zh-CN', { style: 'currency', currency: 'CNY' })}</Text></View>
      </Button> : <View className={styles.card} key={supplier.id} data-testid={`supplier-management-card-${supplier.id}`}>
        <View className={styles.cardHeading}><View className={styles.customerIdentity}><Text className={styles.customerName}>{supplier.name}</Text>
          <Text className={styles.accountStatus}>供货商档案</Text></View>
          <View className={styles.cardActions}><Button className={styles.secondaryAction} disabled={!editable}
            onClick={() => onEditParty('supplier', supplier.id)}>编辑供货商</Button>
            <Button className={styles.primaryAction} onClick={() => onViewBills(supplier.id)}>查看账单</Button></View></View>
        <View className={styles.contactLine}><Text>联系人：{supplier.contact || '未记录'}</Text>
          <Text>电话：{supplier.phone || '未记录'}</Text><Text>地址：{supplier.address || '未记录'}</Text></View>
        {(!supplier.contact || !supplier.phone || !supplier.address) && <Text className={styles.incomplete}>
          资料不完整 · 缺少{[!supplier.contact ? '联系人' : '', !supplier.phone ? '电话' : '', !supplier.address ? '地址' : ''].filter(Boolean).join('、')}，可编辑补充
        </Text>}
        {supplier.remark && <Text className={styles.remark}>{supplier.remark}</Text>}
        <View className={styles.specs}><View className={styles.specsHeading}><Text className={styles.specsTitle}>常用采购资料 · 货物及价格</Text>
          <Button className={styles.specAdd} disabled={!editable} data-testid={`supplier-spec-add-${supplier.id}`}
            onClick={() => setEditingSpec({ supplier })}>新增货物</Button></View>
          <GoodsCards items={supplier.specs || []} editable={editable} onEdit={good => editGood(supplier, good)} />
        </View>
      </View>)}
      {!visible.length && <Text className={styles.empty}>{query ? '没有找到匹配供货商' : '还没有供货商资料'}</Text>}
    </View>
    {editingSpec && <QuoteEditor customer={editingSpec.supplier} supplier seed={editingSpec.seed}
      onClose={() => setEditingSpec(null)} onSaved={async () => { setEditingSpec(null); await onSpecsSaved(); }} />}
  </View>;
}
