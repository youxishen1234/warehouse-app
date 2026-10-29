import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { View, Text, Input, Picker } from '@tarojs/components';
import Taro from '@tarojs/taro';
import Icon, { IconName } from '@/components/Icon';
import { addLedger, deleteLedger, getLedger, settleCustomer, settleSupplier } from '@/services/api';
import type { Customer, DeliveryNote, LedgerAttachment, LedgerEntry, LedgerType, Supplier } from '@/types';
import type { DimensionCustomer } from '@/services/customer-dimensions';
import { formatMoney, formatTime } from '@/utils/format';
import { downloadCsv } from '@/services/download';
import { parseMoneyInput, previewMoneyInput, sanitizeNonNegativeMoneyInput } from '@/utils/form-input';
import {
  amountPrefix, dateBounds, dateKey, filterLedger, groupLedger, isLinkedEntry,
  ledgerTypes, monthRange, summarizeLedger
} from '@/components/FinanceCenter/ledger-model';
import type { PhotoDraft } from '@/services/ledger-photos';
import LedgerAttachments from '@/components/FinanceCenter/attachments';
import FinanceButton from '@/components/FinanceCenter/button';
import {
  buildCustomerManagementRows, MAX_VISIBLE_CUSTOMER_SPECS, specificationSearchText
} from '@/components/CustomerCenter/model';
import type { CustomerSpecView } from '@/components/CustomerCenter/model';
import {
  filterPartyLedgerEntries, inferredPartyType, partyPeriodLabel, summarizePartyLedger,
  summarizeProductionInbound
} from './model';
import type { PartyPeriod } from './model';
import styles from './index.module.scss';
import Statement from './statement';
import type { StatementData } from './statement';

export type FinanceView = 'overview' | 'ledger' | 'customer' | 'supplier';
type PartyType = 'customer' | 'supplier';
type FinanceCenterProps = {
  initialView?: FinanceView;
  partyType?: PartyType;
  partyId?: number;
  entryId?: number;
  ledger: LedgerEntry[];
  customers: Customer[];
  suppliers: Supplier[];
  dimensionCustomers?: DimensionCustomer[];
  inactiveCustomerNames?: string[];
  deliveryNotes: DeliveryNote[];
  loading: boolean;
  loadError: string;
  onReload: () => Promise<void>;
  onViewChange?: (view: FinanceView) => void;
  onEditParty?: (type: PartyType, id?: number, initialName?: string) => void;
};

function CustomerSpecs({ customer, specs, expanded, onToggle }: {
  customer: string;
  specs: CustomerSpecView[];
  expanded: boolean;
  onToggle: () => void;
}) {
  const visible = expanded ? specs : specs.slice(0, MAX_VISIBLE_CUSTOMER_SPECS);
  return <View className={styles.customerSpecs} data-testid={`customer-specs-${customer}`}>
    <View className={styles.customerSpecsHeading}><Text>常用规格</Text><Text className={styles.customerSpecsCount}>{specs.length} 种</Text></View>
    {visible.map(spec => <View className={styles.customerSpecRow} key={spec.key} data-testid={`customer-spec-${customer}-${spec.key}`}>
      <View className={styles.customerSpecBody}>
        <View className={styles.customerSpecTitle}><Text>{spec.goods}</Text>{spec.kind === '纸板' && <Text className={styles.customerSpecKind}>纸板</Text>}</View>
        <Text className={styles.customerSpecSize}>{spec.specification}</Text>
        <Text className={styles.customerSpecMeta}>材质：{spec.material || '未记录'} · 单位：{spec.unit}</Text>
      </View>
      <Text className={styles.customerSpecPrice}>{spec.price == null ? '价格未记录' : `${formatMoney(spec.price)}/${spec.unit}`}</Text>
    </View>)}
    {!specs.length && <Text className={styles.customerSpecsEmpty}>暂无规格资料</Text>}
    {specs.length > MAX_VISIBLE_CUSTOMER_SPECS && <FinanceButton className={styles.customerSpecsToggle} aria-expanded={expanded} data-testid={`customer-specs-toggle-${customer}`} onClick={onToggle}>
      {expanded ? '收起规格' : `查看全部 ${specs.length} 种规格`}
    </FinanceButton>}
  </View>;
}

const appearance: Record<LedgerType, { icon: IconName; color: string; title: string }> = {
  income: { icon: 'inbound', color: '#1677ff', title: '收入入账' },
  expense: { icon: 'outbound', color: '#b45309', title: '支出记账' },
  receivable: { icon: 'clock', color: '#1677ff', title: '新增应收' },
  payable: { icon: 'clock', color: '#b45309', title: '新增应付' },
  settlement: { icon: 'check', color: '#64748b', title: '往来结清' }
};

function entryCategory(entry: LedgerEntry) {
  if (entry.type === 'receivable' && entry.delivery_note_id) return '自产入库应收';
  if (entry.type === 'receivable' && entry.transaction_id) return '出库应收';
  if (entry.type === 'payable' && (entry.transaction_id || entry.delivery_note_id)) return '入库应付';
  return ledgerTypes.find(item => item.value === entry.type)?.label || '流水';
}

function dayLabel(value: string) {
  const date = new Date(`${value}T00:00:00`);
  const today = dateKey(new Date());
  const yesterday = new Date();
  yesterday.setDate(yesterday.getDate() - 1);
  const prefix = value === today ? '今天 · ' : value === dateKey(yesterday) ? '昨天 · ' : '';
  const year = date.getFullYear() === new Date().getFullYear() ? '' : `${date.getFullYear()}年`;
  return `${prefix}${year}${date.getMonth() + 1}月${date.getDate()}日`;
}

type LedgerListRowProps = { entry: LedgerEntry; onOpen: (entry: LedgerEntry) => void };
const LedgerListRow = React.memo(function LedgerListRow({ entry, onOpen }: LedgerListRowProps) {
  const meta = appearance[entry.type];
  return <FinanceButton className={styles.item} data-testid={`ledger-entry-${entry.id}`} onClick={() => onOpen(entry)}>
    <View className={`${styles.entryIcon} ${styles[entry.type]}`}><Icon name={meta.icon} color={meta.color} /></View>
    <View className={styles.itemMain}>
      <Text className={styles.itemTitle}>{entry.party_current_name || entry.party_name || entry.remark || meta.title}</Text>
      <Text className={styles.itemMeta}>{formatTime(entry.created_at).slice(-5)} · {entry.remark || meta.title}</Text>
      {Boolean(entry.attachments?.length) && <View className={styles.attachmentBadge}><Icon name='clipboard' color='#1677ff' /><Text>凭证 {entry.attachments!.length} 张</Text></View>}
    </View>
    <View className={styles.itemRight}>
      <Text className={`${styles.itemAmount} ${styles[`${entry.type}Text`]}`}>{amountPrefix(entry.type)}{formatMoney(entry.amount)}</Text>
      <Text className={`${styles.itemCategory} ${styles[entry.type]} ${styles[`${entry.type}Text`]}`}>{entryCategory(entry)}</Text>
    </View>
    <Icon name='chevron' color='#94a3b8' className={styles.rowChevron} />
  </FinanceButton>;
});

export default function FinanceCenter({
  initialView = 'overview', partyType, partyId, entryId, ledger, customers, suppliers, dimensionCustomers = [], inactiveCustomerNames = [], deliveryNotes,
  loading, loadError, onReload, onViewChange, onEditParty
}: FinanceCenterProps) {
  const [view, setView] = useState<FinanceView>(initialView);
  const [partyDetailsOpen, setPartyDetailsOpen] = useState(Boolean(partyId));
  const [type, setType] = useState<LedgerType | ''>('');
  const [keyword, setKeyword] = useState('');
  const [range, setRange] = useState(() => monthRange());
  const [period, setPeriod] = useState('本月');
  const [statement, setStatement] = useState<StatementData>();
  const [draftRange, setDraftRange] = useState(range);
  const [rangeOpen, setRangeOpen] = useState(false);
  const [rangeError, setRangeError] = useState('');
  const [selected, setSelected] = useState<LedgerEntry | null>(() => ledger.find(entry => entry.id === entryId) || null);
  const [partyFilter, setPartyFilter] = useState<{ type: PartyType; id: number } | null>(() =>
    partyType && partyId && Number.isSafeInteger(partyId) && partyId > 0 ? { type: partyType, id: partyId } : null);
  const [photoDrafts, setPhotoDrafts] = useState<Record<number, PhotoDraft[]>>({});
  const [photoBusy, setPhotoBusy] = useState(false);
  const [amount, setAmount] = useState('');
  const [remark, setRemark] = useState('');
  const [kind, setKind] = useState<'income' | 'expense'>('income');
  const [show, setShow] = useState(false);
  const [saving, setSaving] = useState(false);
  const [exporting, setExporting] = useState(false);
  const [removing, setRemoving] = useState(false);
  const [expanded, setExpanded] = useState<Record<string, boolean>>({});
  const [expandedSpecs, setExpandedSpecs] = useState<Record<string, boolean>>({});
  const [partySearch, setPartySearch] = useState('');
  const [partyPeriod, setPartyPeriod] = useState<PartyPeriod>('全部时间');
  const [partyRange, setPartyRange] = useState({ from: '', to: '' });
  const [settling, setSettling] = useState<{ id: number; name: string; type: PartyType; balance: number } | null>(null);
  const [settlementAmount, setSettlementAmount] = useState('');
  const [settlementError, setSettlementError] = useState('');
  const saveLock = useRef(false), removeLock = useRef(false), exportLock = useRef(false), settleLock = useRef(false);
  const entryRequest = useRef(0);
  const alive = useRef(true);
  const entryLedger = useRef(ledger);
  entryLedger.current = ledger;

  useEffect(() => { onViewChange?.(view); }, [onViewChange, view]);
  useEffect(() => {
    alive.current = true;
    return () => { alive.current = false; };
  }, []);
  useEffect(() => {
    if (!entryId || !Number.isSafeInteger(entryId) || entryId <= 0) return;
    const requestId = ++entryRequest.current;
    let active = true;
    const existing = entryLedger.current.find(item => item.id === entryId);
    if (existing) { setSelected(existing); return; }
    void getLedger({ id: entryId, include_voided: true }).then(rows => {
      if (active && alive.current && requestId === entryRequest.current) setSelected(rows.find(item => item.id === entryId) || null);
    }).catch(error => {
      if (active && alive.current && requestId === entryRequest.current) Taro.showToast({ title: error?.message || '流水详情加载失败', icon: 'none' });
    });
    return () => { active = false; entryRequest.current += 1; };
  }, [entryId]);
  useEffect(() => {
    setSelected(current => {
      if (!current) return current;
      const updated = ledger.find(item => item.id === current.id);
      if (!updated || updated === current) return current;
      // Preserve confirmed uploads until a background refresh includes them.
      const known = new Set((updated.attachments || []).map(item => item.id));
      const pending = (current.attachments || []).filter(item => !known.has(item.id));
      return pending.length ? { ...updated, attachments: [...(updated.attachments || []), ...pending] } : updated;
    });
  }, [ledger]);

  const openEntry = useCallback((entry: LedgerEntry | null) => {
    entryRequest.current += 1;
    setSelected(entry);
  }, []);
  const selectedType: PartyType | '' = partyFilter?.type || '';
  const selectedId = partyFilter?.id || 0;
  const partyDates = useMemo(() => partyRange, [partyRange]);
  const periodLedger = useMemo(() => ledger.filter(entry =>
    !entry.voided_at &&
    (!range.from || entry.created_at >= new Date(`${range.from}T00:00:00`).getTime()) &&
    (!range.to || entry.created_at <= new Date(`${range.to}T23:59:59.999`).getTime())
  ), [ledger, range]);
  const totals = useMemo(() => summarizeLedger(periodLedger), [periodLedger]);
  const filtered = useMemo(() => {
    const scoped = filterLedger(periodLedger, type, keyword);
    return selectedType && selectedId
      ? scoped.filter(item => Number(item.party_id) === selectedId && inferredPartyType(item) === selectedType)
      : scoped;
  }, [keyword, periodLedger, selectedId, selectedType, type]);
  const groups = useMemo(() => groupLedger(filtered), [filtered]);
  const amountPreview = useMemo(() => previewMoneyInput(amount), [amount]);
  const partyRangeText = partyPeriod === '全部时间' ? { from: '', to: '' } : partyDates;
  const allCustomerRows = useMemo(() => buildCustomerManagementRows(customers, dimensionCustomers, inactiveCustomerNames), [customers, dimensionCustomers, inactiveCustomerNames]);
  const customerReceivable = useMemo(() => allCustomerRows.reduce((sum, row) => sum + Number(row.account?.debt || 0), 0), [allCustomerRows]);
  const customerRows = useMemo(() => {
    const query = specificationSearchText(partySearch);
    return allCustomerRows.filter(row =>
      (!selectedId || selectedType !== 'customer' || row.account?.id === selectedId) &&
      (!query || row.searchText.includes(query))
    );
  }, [allCustomerRows, partySearch, selectedId, selectedType]);
  const supplierRows = useMemo(() => suppliers.filter(party => !party.deleted_at && (!selectedId || selectedType !== 'supplier' || party.id === selectedId) &&
    (!partySearch.trim() || `${party.name} ${party.contact || ''} ${party.phone || ''}`.toLowerCase().includes(partySearch.trim().toLowerCase()))), [partySearch, selectedId, selectedType, suppliers]);

  const changeView = (next: FinanceView) => { setView(next); setPartyDetailsOpen(false); openEntry(null); setPartySearch(''); };
  const choosePeriod = (value: string) => {
    setPeriod(value);
    setRange(value === '全部时间' ? { from: '', to: '' } : monthRange(value === '上月' ? -1 : 0));
  };
  const applyRange = () => {
    if (!draftRange.from || !draftRange.to) { setRangeError('请选择开始日期和结束日期'); return; }
    if (draftRange.from > draftRange.to) { setRangeError('开始日期不能晚于结束日期'); return; }
    setRange(draftRange); setPeriod('自定义'); setRangeOpen(false);
  };
  const choosePartyPeriod = (value: PartyPeriod) => {
    setPartyPeriod(value);
    setPartyRange(value === '全部时间' ? { from: '', to: '' } : {
      from: monthRange(value === '上月' ? -1 : 0).from,
      to: monthRange(value === '上月' ? -1 : 0).to
    });
  };
  const save = async () => {
    if (saveLock.current) return;
    let value: number;
    try { value = parseMoneyInput(amount, '金额', true); }
    catch (error) { Taro.showToast({ title: error instanceof Error ? error.message : '金额必须大于 0', icon: 'none' }); return; }
    saveLock.current = true; setSaving(true);
    try {
      await addLedger({ type: kind, amount: value, remark: remark.trim() });
      setAmount(''); setRemark(''); setShow(false);
      setKeyword(''); setType(''); setPeriod('本月'); setRange(monthRange());
      Taro.showToast({ title: '流水保存成功', icon: 'success' });
      await onReload();
    } catch (error) { Taro.showToast({ title: error?.message || '流水保存失败', icon: 'none' }); }
    finally { saveLock.current = false; setSaving(false); }
  };
  const remove = async (entry: LedgerEntry) => {
    if (removeLock.current || isLinkedEntry(entry)) return;
    removeLock.current = true; setRemoving(true);
    try {
      const result = await Taro.showModal({ title: '作废这笔流水？', content: '作废后保留历史记录，不再计入汇总。' + (entry.party_id ? '作废后将同步恢复对应客户/供货商的往来余额。' : '') + '此操作不能撤销。', confirmText: '确认作废', confirmColor: '#b74949' });
      if (!result.confirm) return;
      await deleteLedger(entry.id);
      openEntry(null);
      Taro.showToast({ title: '流水已作废', icon: 'success' });
      await onReload();
    } catch (error) { Taro.showToast({ title: error?.message || '流水作废失败', icon: 'none' }); }
    finally { removeLock.current = false; setRemoving(false); }
  };
  const exportCsv = async () => {
    if (exportLock.current || loading || loadError || filtered.length === 0) return;
    exportLock.current = true; setExporting(true);
    try {
      const bounds = dateBounds(range.from, range.to);
      const query = new URLSearchParams();
      if (type) query.set('type', type);
      if (keyword.trim()) query.set('keyword', keyword.trim());
      if (selectedType && selectedId) { query.set('party_type', selectedType); query.set('party_id', String(selectedId)); }
      if (bounds.from !== undefined) query.set('from', String(bounds.from));
      if (bounds.to !== undefined) query.set('to', String(bounds.to));
      await downloadCsv(`/api/export/ledger.csv${query.toString() ? `?${query}` : ''}`, 'warehouse-ledger.csv');
    } catch (error) { Taro.showToast({ title: error?.message || '导出失败', icon: 'none' }); }
    finally { exportLock.current = false; setExporting(false); }
  };
  const changePhotoDrafts = useCallback((id: number, update: (items: PhotoDraft[]) => PhotoDraft[]) => {
    setPhotoDrafts(current => ({ ...current, [id]: update(current[id] || []) }));
  }, []);
  const photoSaved = useCallback((id: number, attachment: LedgerAttachment) => {
    const update = (entry: LedgerEntry) => entry.id === id && !entry.attachments?.some(item => item.id === attachment.id)
      ? { ...entry, attachments: [...(entry.attachments || []), attachment] } : entry;
    setSelected(current => current ? update(current) : current);
  }, []);
  const settle = async () => {
    if (!settling || settleLock.current) return;
    let value: number;
    try { value = parseMoneyInput(settlementAmount, settling.type === 'customer' ? '收款金额' : '付款金额', true); }
    catch (error) { setSettlementError(error instanceof Error ? error.message : '金额必须大于 0'); return; }
    if (value > settling.balance + 0.00001) {
      setSettlementError(`不能超过当前${settling.type === 'customer' ? '待收款' : '待付款'} ${formatMoney(settling.balance)}`);
      return;
    }
    settleLock.current = true; setSettlementError('');
    try {
      if (settling.type === 'customer') await settleCustomer(settling.id, value, '账单中心 · 客户收款');
      else await settleSupplier(settling.id, value, '账单中心 · 供货商付款');
      const settledPartyType = settling.type;
      setSettling(null); setSettlementAmount('');
      Taro.showToast({ title: settledPartyType === 'customer' ? '收款已保存' : '付款已保存', icon: 'success' });
      await onReload();
    } catch (error) { setSettlementError(error?.message || '账单收款保存失败'); }
    finally { settleLock.current = false; }
  };

  const tabLabels: { id: FinanceView; label: string }[] = [
    { id: 'overview', label: '全部往来' },
    { id: 'customer', label: '待收款' },
    { id: 'supplier', label: '待付款' },
    { id: 'ledger', label: '收支流水' }
  ];
  const partyTitle = view === 'supplier' ? '供货商账单' : '客户账单';
  const parties = [
    ...(view === 'supplier' ? [] : customerRows.flatMap(row => row.account && Number(row.account.debt || 0) > 0 ? [{ type: 'customer' as const, id: row.account.id, name: row.name, balance: Number(row.account.debt) }] : [])),
    ...(view === 'customer' ? [] : supplierRows.filter(row => Number(row.payable || 0) > 0).map(row => ({ type: 'supplier' as const, id: row.id, name: row.name, balance: Number(row.payable) })))
  ];

  return <View className={styles.finance} data-testid='finance-center'>
    <View className={styles.overviewTotals}><View><Text>客户待收款</Text><strong>{loading && !customers.length ? '—' : formatMoney(customerReceivable)}</strong></View><View><Text>供货商待付款</Text><strong>{loading && !suppliers.length ? '—' : formatMoney(suppliers.filter(row => !row.deleted_at).reduce((sum, row) => sum + Number(row.payable || 0), 0))}</strong></View></View>
    {!partyDetailsOpen && <Input className={styles.partySearch} aria-label='搜索客户、供货商或收付款记录' placeholder='搜索客户、供货商或收付款记录' value={view === 'ledger' ? keyword : partySearch} onInput={e => view === 'ledger' ? setKeyword(e.detail.value) : setPartySearch(e.detail.value)} />}
    <View className={styles.tabs} data-testid='finance-tabs' role='tablist' aria-label='账单中心分类'>
      {tabLabels.map(tab => <FinanceButton key={tab.id} role='tab' aria-selected={view === tab.id} aria-pressed={view === tab.id} data-testid={`finance-tab-${tab.id}`} className={`${styles.tab} ${view === tab.id ? styles.tabActive : ''}`} onClick={() => changeView(tab.id)}>{tab.label}</FinanceButton>)}
    </View>
    {view !== 'ledger' && !partyDetailsOpen && <View data-testid={`finance-${view}-view`}>
      {parties.map(party => <View key={`${party.type}-${party.id}`} className={styles.overviewCard}>
        <View className={styles.overviewRow}><View className={styles.overviewAvatar}>{party.type === 'customer' ? '客' : '供'}</View><View className={styles.overviewIdentity}><strong>{party.name}</strong><Text>{party.type === 'customer' ? '客户应收' : '供货商应付'}</Text></View><strong className={styles.overviewAmount}>{formatMoney(party.balance)}</strong></View>
        <View className={styles.overviewFoot}><FinanceButton className={styles.overviewDetail} onClick={() => { setView(party.type); setPartyFilter({ type: party.type, id: party.id }); setPartyDetailsOpen(true); }}>查看明细 ›</FinanceButton><FinanceButton className={styles.overviewSettle} data-testid={`finance-settle-${party.type}-${party.id}`} onClick={() => { setSettling(party); setSettlementAmount(''); setSettlementError(''); }}>登记{party.type === 'customer' ? '收款' : '付款'}</FinanceButton></View>
      </View>)}
      {!parties.length && <View className={styles.empty}><Text>{loading ? '正在同步往来记录…' : partySearch ? '暂无匹配记录' : '暂无待结算往来'}</Text></View>}
      {(view === 'customer' || view === 'supplier') && <FinanceButton className={styles.overviewDetail} data-testid={`finance-add-${view}`} onClick={() => onEditParty?.(view)}>{view === 'customer' ? '客户管理' : '供货商管理'} ›</FinanceButton>}
      <View className={styles.ledgerActions}><FinanceButton className={styles.primary} data-testid='finance-add-entry' onClick={() => { openEntry(null); setShow(true); }}>＋ 记一笔</FinanceButton></View>
    </View>}

    {view === 'ledger' && <View className={styles.ledgerView} data-testid='finance-ledger-view'>
      <View className={styles.toolbar}>
        <View className={styles.periodTabs}>{['本月', '上月', '全部时间'].map(value => <FinanceButton key={value} aria-pressed={period === value} className={`${styles.periodTab} ${period === value ? styles.periodActive : ''}`} onClick={() => choosePeriod(value)}>{value}</FinanceButton>)}</View>
        <FinanceButton className={`${styles.rangeButton} ${period === '自定义' ? styles.rangeActive : ''}`} onClick={() => { setDraftRange(range); setRangeError(''); setRangeOpen(true); }}><Icon name='clock' color='#64748b' /><Text>{period === '自定义' ? '已选日期' : '选日期'}</Text></FinanceButton>
      </View>
      <View className={styles.summary} data-testid='finance-cash-summary'>
        <View className={styles.summaryTop}><Text>{period}收支净额</Text><Text className={styles.summaryTag}>{period === '自定义' ? '自选日期' : range.from ? range.from.slice(0, 7).replace('-', '.') : '全部日期'}</Text></View>
        <Text className={styles.netAmount}>{formatMoney(totals.net)}</Text>
        <View className={styles.cashGrid}><View><Text>实际收入</Text><strong>{formatMoney(totals.income)}</strong></View><View><Text>实际支出</Text><strong>{formatMoney(totals.expense)}</strong></View></View>
      </View>
      <View className={styles.accruals} data-testid='finance-accrual-summary'>
        {(['receivable', 'payable', 'settlement'] as const).map(value => <FinanceButton key={value} aria-pressed={type === value} className={`${styles.accrual} ${type === value ? styles.accrualActive : ''}`} onClick={() => { setType(value); setKeyword(''); }}>
          <Text>{value === 'receivable' ? '期间应收' : value === 'payable' ? '期间应付' : '期间结清'}</Text><strong>{formatMoney(totals[value])}</strong>
        </FinanceButton>)}
      </View>
      <Text className={styles.cashNote}>应收、应付、结清不是现金收支，不计入净额。</Text>
      <View className={styles.listPanel} id='ledger-detail-list'>
        <View className={styles.listHeading}><View><Text>流水明细</Text><Text className={styles.count}>{loading ? '同步中' : `${filtered.length} 笔`}</Text></View><View className={styles.headingActions}>
          <FinanceButton aria-label='刷新账单流水' disabled={loading} onClick={() => void onReload()}>{loading ? '更新中' : '刷新'}</FinanceButton>
          <FinanceButton aria-label='导出账单流水 CSV' disabled={loading || Boolean(loadError) || exporting || filtered.length === 0} onClick={() => void exportCsv()}>{exporting ? '导出中…' : '导出 CSV'}</FinanceButton>
        </View></View>
        <View className={styles.search}><Icon name='search' color='#64748b' /><Input aria-label='搜索账单流水' placeholder='搜索客户、供应商或备注' value={keyword} maxlength={100} onInput={e => setKeyword(e.detail.value)} /><FinanceButton aria-label='清空搜索' onClick={() => setKeyword('')} style={{ visibility: keyword ? 'visible' : 'hidden' }}>×</FinanceButton></View>
        <View className={styles.typeTabs}>{ledgerTypes.map(item => <FinanceButton key={item.value || 'all'} aria-pressed={type === item.value} className={`${styles.typeTab} ${type === item.value ? styles.typeActive : ''}`} onClick={() => setType(item.value)}>{item.label}</FinanceButton>)}</View>
        {(selectedType || type || keyword.trim()) && <View className={styles.filterStatus}><Text>{selectedType ? `${selectedType === 'customer' ? '客户' : '供货商'} · #${selectedId}` : ''}{selectedType && type ? ' · ' : ''}{type ? `${ledgerTypes.find(item => item.value === type)?.label}流水` : ''}{keyword.trim() ? `${selectedType || type ? ' · ' : ''}“${keyword.trim()}”` : ''}</Text>
          <FinanceButton onClick={() => { if (selectedType) { setPartyFilter(null); setType(''); setKeyword(''); return; } setType(''); setKeyword(''); }}>{selectedType ? '清除对象筛选' : '重置'}</FinanceButton>
        </View>}
        {loading ? <View className={styles.empty}><Text>正在同步账单流水…</Text></View>
          : loadError ? <View className={styles.empty} role='alert'><Text>账单加载失败 · {loadError}</Text><FinanceButton onClick={() => void onReload()}>重新加载</FinanceButton></View>
            : groups.length === 0 ? <View className={styles.empty}><Text>{type || keyword ? '没有找到匹配的流水' : '这段时间还没有流水'}</Text><FinanceButton onClick={() => (type || keyword ? (setType(''), setKeyword('')) : setShow(true))}>{type || keyword ? '清除筛选' : '记一笔'}</FinanceButton></View>
              : groups.map(group => <View className={styles.dayGroup} key={group.date}>
                <View className={styles.dayHeading}><Text>{dayLabel(group.date)} · 周{'日一二三四五六'[new Date(`${group.date}T00:00:00`).getDay()]}</Text><Text>{group.entries.length} 笔</Text></View>
                {group.entries.map(entry => <LedgerListRow key={entry.id} entry={entry} onOpen={openEntry} />)}
              </View>)}
      </View>
      <View className={styles.ledgerActions}><FinanceButton className={styles.primary} data-testid='finance-add-entry' onClick={() => { openEntry(null); setShow(true); }}>＋ 记一笔</FinanceButton></View>
    </View>}

    {partyDetailsOpen && (view === 'customer' || view === 'supplier') && <View className={styles.partyView} data-testid={`finance-${view}-view`}>
      <FinanceButton className={styles.overviewDetail} onClick={() => { setPartyDetailsOpen(false); setPartyFilter(null); }}>‹ 返回往来列表</FinanceButton>
      <View className={styles.partyToolbar}>
        <FinanceButton className={`${styles.primary} ${styles.partyAddButton}`} data-testid={`finance-add-${view}`} onClick={() => onEditParty?.(view)}><Icon name='notebook' color='#fff' /><Text>{view === 'customer' ? '客户管理' : '供货商管理'}</Text></FinanceButton>
        <Input className={styles.partySearch} data-testid='finance-party-search' aria-label={view === 'customer' ? '搜索客户、规格或联系方式' : `搜索${partyTitle}`} placeholder={view === 'customer' ? '搜索客户、规格或联系方式' : `搜索${partyTitle}对象`} value={partySearch} onInput={e => setPartySearch(e.detail.value)} />
        <View className={styles.periodTabs}>{(['本月', '上月', '全部时间'] as PartyPeriod[]).map(value => <FinanceButton key={value} aria-pressed={partyPeriod === value} className={`${styles.periodTab} ${partyPeriod === value ? styles.periodActive : ''}`} onClick={() => choosePartyPeriod(value)}>{value}</FinanceButton>)}</View>
      </View>
      <View className={styles.partySummary} data-testid='finance-party-summary'>
        <View><Text>{view === 'customer' ? '当前待收款合计' : '当前待付款合计'}</Text><strong>{formatMoney(view === 'customer' ? customerReceivable : supplierRows.reduce((sum, supplier) => sum + Number(supplier.payable || 0), 0))}</strong></View>
        <Text>{partyPeriod === '全部时间' ? '按全部业务日期汇总 · 当前余额为实时数' : `${partyRange.from} 至 ${partyRange.to} · 当前余额为实时数`}</Text>
      </View>
      {view === 'customer' && customerRows.map(row => {
        if (!row.account) return <View key={row.key} className={styles.partyCard} data-testid={`customer-specs-only-${row.key}`}>
          <View className={styles.partyCardHead}><View><Text className={styles.partyName}>{row.name}</Text><Text className={styles.dimensionOnlyStatus}>规格客户 · 未建立客户资料</Text></View><View className={styles.partyButtons}>
            <FinanceButton className={styles.primary} aria-label={`在客户管理建立资料 ${row.name}`} data-testid={`customer-create-from-dimension-${row.key}`} onClick={() => onEditParty?.('customer')}>前往客户管理</FinanceButton>
          </View></View>
          <CustomerSpecs customer={row.key} specs={row.specs} expanded={Boolean(expandedSpecs[row.key])} onToggle={() => setExpandedSpecs(current => ({ ...current, [row.key]: !current[row.key] }))} />
          <Text className={styles.dimensionOnlyNote}>建立客户资料后，可登记应收、收款和自产入库账单。</Text>
        </View>;
        const customer = row.account;
        const notes = summarizeProductionInbound(deliveryNotes, customer.id, partyRangeText.from, partyRangeText.to);
        const balance = Number(customer.debt || 0);
        const expandedKey = `customer-${customer.id}`;
        const customerNotes = deliveryNotes.filter(note => note.source_type === 'production' && note.customer_id != null && Number(note.customer_id) === customer.id && !note.voided_at);
        const productionNoteIds = new Set(customerNotes.map(note => Number(note.id)));
        const rows = filterPartyLedgerEntries(ledger, 'customer', customer.id, partyRangeText.from, partyRangeText.to)
          .filter(entry => !productionNoteIds.has(Number(entry.delivery_note_id)));
        const summary = summarizePartyLedger(rows, 'customer');
        return <View key={customer.id} className={styles.partyCard} data-testid={`customer-bill-${customer.id}`}>
          <View className={styles.partyCardHead}><View><Text className={styles.partyName}>{customer.name}</Text><Text className={styles.balance}>当前待收款 {formatMoney(balance)}</Text></View><View className={styles.partyButtons}>
            <FinanceButton className={styles.primary} aria-label={`收款客户 ${customer.name}`} data-testid={`finance-settle-customer-${customer.id}`} onClick={() => { setSettling({ id: customer.id, name: customer.name, type: 'customer', balance }); setSettlementAmount(''); setSettlementError(''); }}>收款</FinanceButton>
            <FinanceButton aria-label={`编辑客户 ${customer.name}`} onClick={() => onEditParty?.('customer', customer.id)}>编辑</FinanceButton>
            <FinanceButton aria-label={`打印客户对账单 ${customer.name}`} onClick={() => setStatement({ name: customer.name, type: 'customer', from: partyRangeText.from, to: partyRangeText.to, balance, entries: filterPartyLedgerEntries(ledger, 'customer', customer.id, partyRangeText.from, partyRangeText.to).slice().sort((a, b) => a.created_at - b.created_at) })}>对账单</FinanceButton>
          </View></View>
          <CustomerSpecs customer={String(customer.id)} specs={row.specs} expanded={Boolean(expandedSpecs[expandedKey])} onToggle={() => setExpandedSpecs(current => ({ ...current, [expandedKey]: !current[expandedKey] }))} />
          <View className={styles.metrics}>
            <View><Text>{partyPeriodLabel(partyPeriod)}自产入库金额</Text><strong>{formatMoney(notes.total)}</strong></View>
            <View><Text>{partyPeriodLabel(partyPeriod)}已收款</Text><strong>{formatMoney(summary.settled)}</strong></View>
          </View>
          <FinanceButton className={styles.expandButton} aria-expanded={Boolean(expanded[expandedKey])} aria-label={`查看客户自产入库明细 ${customer.name}`} data-testid={`customer-bill-details-${customer.id}`} onClick={() => setExpanded(current => ({ ...current, [expandedKey]: !current[expandedKey] }))}>
            {expanded[expandedKey] ? '收起' : '展开'}自产入库明细 · {notes.count} 笔
          </FinanceButton>
          {expanded[expandedKey] && <View className={styles.partyDetails}>
            <Text className={styles.detailSectionTitle}>自产入库 · {partyPeriod === '全部时间' ? '全部日期' : `${partyRange.from} 至 ${partyRange.to}`} · 合计 {formatMoney(notes.total)}</Text>
            {notes.notes.map(note => <View key={note.id} className={styles.productionRow} data-testid={`production-inbound-${note.id}`}>
              <View><Text>{note.date} · {note.work_order_no || `生产入库 #${note.id}`}</Text><Text>{note.remark || '自产纸箱入库'}</Text></View><strong>{formatMoney(summarizeProductionInbound([note], customer.id).total)}</strong>
            </View>)}
            {!notes.count && <Text className={styles.muted}>该日期范围内暂无客户自产入库</Text>}
            <Text className={styles.detailSectionTitle}>出库应收与收款记录</Text>
            {rows.map(entry => <FinanceButton key={entry.id} className={styles.partyLedgerRow} onClick={() => { setView('ledger'); openEntry(entry); }}>
              <Text>{entry.type === 'settlement' ? (entry.party_type === 'supplier' ? '付款' : '收款') : entryCategory(entry)} · {formatTime(entry.created_at)}</Text>
              <strong>{formatMoney(entry.amount)}</strong><Text>{entry.remark || entryCategory(entry)}</Text>
            </FinanceButton>)}
            {!rows.length && <Text className={styles.muted}>暂无其他出库或收付流水</Text>}
          </View>}
        </View>;
      })}
      {view === 'supplier' && supplierRows.map(supplier => {
        const balance = Number(supplier.payable || 0);
        const key = `supplier-${supplier.id}`;
        const rows = filterPartyLedgerEntries(ledger, 'supplier', supplier.id, partyRangeText.from, partyRangeText.to);
        const summary = summarizePartyLedger(rows, 'supplier');
        return <View key={supplier.id} className={styles.partyCard} data-testid={`supplier-bill-${supplier.id}`}>
          <View className={styles.partyCardHead}><View><Text className={styles.partyName}>{supplier.name}</Text><Text className={styles.balance}>当前待付款 {formatMoney(balance)}</Text></View><View className={styles.partyButtons}>
            <FinanceButton className={styles.primary} aria-label={`付款给供货商 ${supplier.name}`} data-testid={`finance-settle-supplier-${supplier.id}`} onClick={() => { setSettling({ id: supplier.id, name: supplier.name, type: 'supplier', balance }); setSettlementAmount(''); setSettlementError(''); }}>付款</FinanceButton>
            <FinanceButton aria-label={`编辑供货商 ${supplier.name}`} onClick={() => onEditParty?.('supplier', supplier.id)}>编辑</FinanceButton>
            <FinanceButton aria-label={`打印供货商对账单 ${supplier.name}`} onClick={() => setStatement({ name: supplier.name, type: 'supplier', from: partyRangeText.from, to: partyRangeText.to, balance, entries: rows.slice().sort((a, b) => a.created_at - b.created_at) })}>对账单</FinanceButton>
          </View></View>
          <View className={styles.metrics}><View><Text>{partyPeriodLabel(partyPeriod)}纸板入库与应付</Text><strong>{formatMoney(summary.sales)}</strong></View><View><Text>{partyPeriodLabel(partyPeriod)}已付款</Text><strong>{formatMoney(summary.settled)}</strong></View></View>
          <FinanceButton className={styles.expandButton} aria-expanded={Boolean(expanded[key])} aria-label={`查看供货商账单明细 ${supplier.name}`} onClick={() => setExpanded(current => ({ ...current, [key]: !current[key] }))}>{expanded[key] ? '收起' : '展开'}供货商账单明细 · {rows.length} 笔</FinanceButton>
          {expanded[key] && <View className={styles.partyDetails}>{rows.map(entry => <FinanceButton key={entry.id} className={styles.partyLedgerRow} onClick={() => { setView('ledger'); openEntry(entry); }}>
            <Text>{entryCategory(entry)} · {formatTime(entry.created_at)}</Text><strong>{formatMoney(entry.amount)}</strong><Text>{entry.remark || entryCategory(entry)}</Text>
          </FinanceButton>)}{!rows.length && <Text className={styles.muted}>暂无供货商应付或付款流水</Text>}</View>}
        </View>;
      })}
      {(view === 'customer' ? customerRows.length : supplierRows.length) === 0 && <View className={styles.empty}><Text>{partySearch ? '没有找到匹配对象' : `还没有${view === 'customer' ? '客户' : '供货商'}资料`}</Text></View>}
    </View>}

    {statement && <Statement data={statement} onClose={() => setStatement(undefined)} />}
    {rangeOpen && <View className={styles.overlay}><View className={styles.backdrop} aria-hidden='true' onClick={() => setRangeOpen(false)} /><View className={styles.sheet} role='dialog' aria-modal='true' aria-label='筛选账单日期'>
      <View className={styles.sheetHeader}><Text>筛选日期</Text><FinanceButton aria-label='关闭日期筛选' onClick={() => setRangeOpen(false)}>×</FinanceButton></View>
      <View className={styles.dateFields}><View><Text>开始日期</Text><Picker mode='date' value={draftRange.from} onChange={e => { setDraftRange(current => ({ ...current, from: e.detail.value })); setRangeError(''); }}><View className={styles.datePicker}>{draftRange.from || '请选择日期'}</View></Picker></View><Text>—</Text><View><Text>结束日期</Text><Picker mode='date' value={draftRange.to} onChange={e => { setDraftRange(current => ({ ...current, to: e.detail.value })); setRangeError(''); }}><View className={styles.datePicker}>{draftRange.to || '请选择日期'}</View></Picker></View></View>
      {rangeError && <View role='alert' className={styles.error}>{rangeError}</View>}
      <FinanceButton className={styles.primary} onClick={applyRange}>应用日期</FinanceButton>
    </View></View>}

    {show && <View className={styles.overlay}><View className={styles.backdrop} aria-hidden='true' onClick={() => { if (!saving) setShow(false); }} /><View className={styles.sheet} role='dialog' aria-modal='true' aria-label='记一笔'>
      <View className={styles.sheetHeader}><Text>记一笔</Text><FinanceButton aria-label='关闭新增流水' disabled={saving} onClick={() => setShow(false)}>×</FinanceButton></View>
      <Text className={styles.sheetDescription}>记录日常实际收入或支出。应收、应付由业务单据生成。</Text>
      <View className={styles.kindTabs}>{(['income', 'expense'] as const).map(value => <FinanceButton key={value} aria-pressed={kind === value} className={`${styles.kindTab} ${kind === value ? styles.kindActive : ''}`} disabled={saving} onClick={() => setKind(value)}><Icon name={appearance[value].icon} color={appearance[value].color} />{value === 'income' ? '收入' : '支出'}</FinanceButton>)}</View>
      <Text className={styles.fieldLabel}>金额</Text><View className={styles.amountField}><Text>¥</Text><Input aria-label='流水金额' type='digit' placeholder='0.00' value={amount} disabled={saving} onInput={e => setAmount(sanitizeNonNegativeMoneyInput(e.detail.value))} /></View>
      <Text className={styles.remark}>本次金额预览 {amountPreview === null ? '—' : formatMoney(amountPreview)}</Text>
      <View className={styles.remarkLabel}><Text>备注</Text><Text>选填 · {remark.length}/200</Text></View><Input aria-label='流水备注' className={styles.remarkInput} placeholder='例如：货款、运费、日常采购' value={remark} maxlength={200} disabled={saving} onInput={e => setRemark(e.detail.value)} />
      <View className={styles.remarkPresets}>{(kind === 'income' ? ['客户货款', '其他收入'] : ['运输费', '日常采购', '办公支出']).map(value => <FinanceButton key={value} disabled={saving} onClick={() => setRemark(value)}>{value}</FinanceButton>)}</View>
      <FinanceButton className={styles.primary} disabled={saving} data-testid='finance-save-entry' onClick={() => void save()}>{saving ? '保存中…' : '保存流水'}</FinanceButton>
    </View></View>}

    {settling && <View className={styles.overlay}><View className={styles.backdrop} aria-hidden='true' onClick={() => { if (!settleLock.current) setSettling(null); }} /><View className={styles.sheet} role='dialog' aria-modal='true' aria-label={settling.type === 'customer' ? '客户收款' : '供货商付款'}>
      <View className={styles.sheetHeader}><Text>{settling.type === 'customer' ? '客户收款' : '供货商付款'}</Text><FinanceButton aria-label='关闭收付款弹窗' disabled={settleLock.current} onClick={() => setSettling(null)}>×</FinanceButton></View>
      <Text className={styles.sheetDescription}>{settling.type === 'customer' ? '收到' : '付给'} {settling.name} · 当前{settling.type === 'customer' ? '待收款' : '待付款'} {formatMoney(settling.balance)}</Text>
      <Text className={styles.fieldLabel}>{settling.type === 'customer' ? '本次收款金额' : '本次付款金额'}</Text>
      <View className={styles.amountField}><Text>¥</Text><Input aria-label={settling.type === 'customer' ? '客户收款金额' : '供货商付款金额'} type='digit' placeholder='0.00' value={settlementAmount} onInput={e => { setSettlementAmount(sanitizeNonNegativeMoneyInput(e.detail.value)); setSettlementError(''); }} /></View>
      {settlementError && <View className={styles.error} role='alert'>{settlementError}</View>}
      <FinanceButton className={styles.primary} data-testid={`finance-confirm-${settling.type}-${settling.id}`} onClick={() => void settle()}>{settling.type === 'customer' ? '确认收款' : '确认付款'}</FinanceButton>
    </View></View>}

    {selected && <View className={styles.overlay}><View className={styles.backdrop} aria-hidden='true' onClick={() => { if (!removing && !photoBusy) openEntry(null); }} /><View className={styles.sheet} role='dialog' aria-modal='true' aria-label='流水详情'>
      <View className={styles.sheetHeader}><Text>流水详情</Text><FinanceButton aria-label='关闭流水详情' disabled={removing || photoBusy} onClick={() => openEntry(null)}>×</FinanceButton></View>
      <View className={styles.detailHero}><View className={`${styles.entryIcon} ${styles[selected.type]}`}><Icon name={appearance[selected.type].icon} color={appearance[selected.type].color} /></View><Text>{entryCategory(selected)} · {selected.party_current_name || selected.party_name || '日常记账'}</Text><strong className={styles.detailAmount}>{amountPrefix(selected.type)}{formatMoney(selected.amount)}</strong></View>
      <View className={styles.detailRows}>
        <View><Text>流水编号</Text><Text>LS-{String(selected.id).padStart(6, '0')}</Text></View>
        <View><Text>记账时间</Text><Text>{formatTime(selected.created_at)}</Text></View>
        <View><Text>往来对象</Text><Text>{selected.party_current_name || selected.party_name || '未关联对象'}</Text></View>
        <View><Text>记录来源</Text><Text>{selected.transaction_id ? `出入库记录 #${selected.transaction_id}` : selected.delivery_note_id ? `送货单 #${selected.delivery_note_id}` : selected.party_id ? '客户 / 供货商往来' : '手动记账'}</Text></View>
        <View><Text>备注说明</Text><Text>{selected.remark || '未填写备注'}</Text></View>
      </View>
      <LedgerAttachments key={selected.id} entry={selected} drafts={photoDrafts[selected.id] || []} onDrafts={changePhotoDrafts} onSaved={photoSaved} onBusy={setPhotoBusy} />
      {isLinkedEntry(selected) ? <Text className={styles.linkedNote}>关联业务单据请从原单处理。</Text> : <FinanceButton className={styles.voidButton} disabled={removing || photoBusy} onClick={() => void remove(selected)}>{removing ? '处理中…' : '作废流水'}</FinanceButton>}
    </View></View>}
  </View>;
}
