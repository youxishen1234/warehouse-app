/* eslint-disable react/forbid-elements */
import { useMemo, useState } from 'react';
import { Button, Input, Text, View } from '@tarojs/components';
import Taro from '@tarojs/taro';
import { DemoSheet, DemoDetail } from '@/components/DemoUI';
import { openBusinessPage } from '@/services/business-navigation';
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
    return !supplier.deleted_at
      && (filter === 'all' || (filter === 'pinned' ? recentIds.includes(supplier.id) : Number(supplier.payable || 0) > 0))
      && (!needle || [supplier.name, supplier.contact, supplier.phone, ...(supplier.specs || []).map(spec => spec.goods)]
        .join(' ').toLocaleLowerCase().replace(/\s+/g, '').includes(needle));
  }), [suppliers, query, filter, recentIds]);
  const editGood = (supplier: Supplier, good: PartyGood) => {
    const record = supplier.specs?.find(spec => spec.id === good.id);
    if (record) setEditingSpec({ supplier, seed: specView(record) });
  };

  const selected = suppliers.find(supplier => supplier.id === selectedId && !supplier.deleted_at);
  return <View className={styles.customerCenter} data-testid='supplier-center'>
    <View className={styles.supplierSummary}><View><Text>合作供货商</Text><strong>{suppliers.filter(row => !row.deleted_at).length}<small>家</small></strong></View><View><Text>待付合计</Text><strong>{suppliers.filter(row => !row.deleted_at).reduce((sum, row) => sum + Number(row.payable || 0), 0).toLocaleString('zh-CN', { style: 'currency', currency: 'CNY' })}</strong></View></View>
    <Input className={styles.search} value={query} aria-label='搜索供货商、联系人、电话或货物名称'
      placeholder='搜索供货商、联系人、电话或货物名称' onInput={event => { setQuery(event.detail.value); setSelectedId(null); }} />
    <View className={styles.toolbar}><Button className={styles.primaryAction} data-testid='supplier-center-add'
      disabled={!editable} onClick={() => onEditParty('supplier')}>新增供货商</Button></View>
    <View className={styles.filters}>{([['all', '全部供货商'], ['pinned', '常用'], ['debt', '待付款']] as const).map(([value, label]) => <Button key={value} className={filter === value ? styles.filterActive : styles.filter} aria-pressed={filter === value} onClick={() => setFilter(value)}>{label}</Button>)}</View>
    <View className={styles.list} aria-live='polite'>
      {visible.map(supplier => <Button className={styles.listCard} key={supplier.id} data-testid={`supplier-management-card-${supplier.id}`} onClick={() => setSelectedId(supplier.id)}>
        <View className={styles.listCardTop}><View className={styles.partyAvatar}>{Array.from(supplier.name)[0]}</View><View className={styles.listCardIdentity}><strong>{supplier.name}</strong><Text>{[supplier.contact, supplier.phone].filter(Boolean).join(' · ')}</Text></View><Text className={styles.listChevron}>›</Text></View>
        <View className={styles.listCardFoot}><Text>常购规格 {(supplier.specs || []).length} 种</Text><Text>待付 {Number(supplier.payable || 0).toLocaleString('zh-CN', { style: 'currency', currency: 'CNY' })}</Text></View>
      </Button>)}
      {!visible.length && <Text className={styles.empty}>{query ? '没有找到匹配供货商' : '还没有供货商资料'}</Text>}
    </View>
    {selected && <DemoSheet title={selected.name} onClose={() => setSelectedId(null)} testId='supplier-detail-sheet'>
      <p>{[selected.contact, selected.phone].filter(Boolean).join(' · ')}</p>
      <DemoDetail label='当前待付款'>{Number(selected.payable || 0).toLocaleString('zh-CN', { style: 'currency', currency: 'CNY' })}</DemoDetail>
      <DemoDetail label='地址'>{selected.address || '未填写'}</DemoDetail>
      <h3 style={{ marginTop: 20 }}>常购纸板规格</h3>
      {(selected.specs || []).map(good => <article className='demo-card' key={good.id} data-testid={`party-good-${good.id}`}><div className='demo-row'><h3>{good.goods || good.specification}</h3><button type='button' className='demo-action' disabled={!editable} onClick={() => editGood(selected, good)}>编辑</button></div><p>{[good.specification, good.material].filter(Boolean).join(' · ')}</p><DemoDetail label='采购单价'>{(good.unitPrice ?? good.price) == null ? '未记录' : `¥ ${good.unitPrice ?? good.price} / ${good.unit || '㎡'}`}</DemoDetail><button type='button' className='demo-primary demo-secondary' onClick={() => void openBusinessPage(`/pages/board-inbound/index?supplier_id=${selected.id}&spec_id=${encodeURIComponent(good.id)}`)}>到货入库</button></article>)}
      <button type='button' className='demo-primary demo-secondary' data-testid={`supplier-spec-add-${selected.id}`} disabled={!editable} onClick={() => setEditingSpec({ supplier: selected })}>＋ 新增货物</button>
      <div className='demo-two'><button type='button' className='demo-primary demo-secondary' disabled={!editable} onClick={() => onEditParty('supplier', selected.id)}>编辑供货商</button><button type='button' className='demo-primary' onClick={() => onViewBills(selected.id)}>查看账单</button></div>
    </DemoSheet>}
    {editingSpec && <QuoteEditor customer={editingSpec.supplier} supplier seed={editingSpec.seed}
      onClose={() => setEditingSpec(null)} onSaved={async () => { setEditingSpec(null); await onSpecsSaved(); }} />}
  </View>;
}
