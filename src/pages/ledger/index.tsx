import { useSharedRefresh } from '@/services/shared-refresh';
import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { View, Text, Input, Picker, ScrollView } from '@tarojs/components';
import Taro from '@tarojs/taro';
import Icon from '@/components/Icon';
import type { IconName } from '@/components/Icon';
import { addLedger, deleteLedger, getLedger, LedgerEntry, LedgerType } from '@/services/api';
import { formatMoney, formatTime } from '@/utils/format';
import { downloadCsv } from '@/services/download';
import { parseMoneyInput, previewMoneyInput, sanitizeNonNegativeMoneyInput } from '@/utils/form-input';
import { amountPrefix, dateBounds, dateKey, filterLedger, groupLedger, isLinkedEntry, ledgerTypes as types, monthRange, summarizeLedger } from './model';
import type { LedgerAttachment } from '@/types';
import type { PhotoDraft } from '@/services/ledger-photos';
import LedgerAttachments from './attachments';
import Button from './button';
import styles from './index.module.scss';

const appearance: Record<LedgerType, { icon: IconName; color: string; title: string }> = {
  income: { icon: 'inbound', color: '#167c60', title: '收入入账' },
  expense: { icon: 'outbound', color: '#b7763b', title: '支出记账' },
  receivable: { icon: 'clock', color: '#557cad', title: '新增应收' },
  payable: { icon: 'clock', color: '#987646', title: '新增应付' },
  settlement: { icon: 'check', color: '#777986', title: '往来结清' }
};

function entryCategory(entry: LedgerEntry) {
  if (entry.type === 'receivable' && entry.transaction_id) return '出库应收';
  if (entry.type === 'payable' && (entry.transaction_id || entry.delivery_note_id)) return '入库应付';
  return types.find(item => item.value === entry.type)?.label || '流水';
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
  return <Button className={styles.item} onClick={() => onOpen(entry)}>
    <View className={`${styles.entryIcon} ${styles[entry.type]}`}><Icon name={meta.icon} color={meta.color} /></View>
    <View className={styles.itemMain}>
      <Text className={styles.itemTitle}>{entry.party_name || entry.remark || meta.title}</Text>
      <Text className={styles.itemMeta}>{formatTime(entry.created_at).slice(-5)}<Text className={styles.metaDot}>·</Text>{entry.party_name ? entry.remark || meta.title : meta.title}</Text>
      {Boolean(entry.attachments?.length) && <View className={styles.attachmentBadge}><Icon name='clipboard' color='#79936a' /><Text>凭证 {entry.attachments!.length} 张</Text></View>}
    </View>
    <View className={styles.itemRight}>
      <Text className={`${styles.itemAmount} ${styles[`${entry.type}Text`]}`}>{amountPrefix(entry.type)}{formatMoney(entry.amount)}</Text>
      <Text className={`${styles.itemCategory} ${styles[entry.type]} ${styles[`${entry.type}Text`]}`}>{entryCategory(entry)}</Text>
    </View>
    <Icon name='chevron' color='#b6bdb8' className={styles.rowChevron} />
  </Button>;
});

export default function LedgerPage() {
  const [list, setList] = useState<LedgerEntry[]>([]);
  const [type, setType] = useState<LedgerType | ''>('');
  const [keyword, setKeyword] = useState('');
  const [range, setRange] = useState(() => monthRange());
  const [period, setPeriod] = useState('本月');
  const [rangeOpen, setRangeOpen] = useState(false);
  const [draftRange, setDraftRange] = useState(range);
  const [rangeError, setRangeError] = useState('');
  const [scrollTarget, setScrollTarget] = useState('');
  const [show, setShow] = useState(false);
  const [selected, setSelected] = useState<LedgerEntry | null>(null);
  const [photoDrafts, setPhotoDrafts] = useState<Record<number, PhotoDraft[]>>({});
  const [photoBusy, setPhotoBusy] = useState(false);
  const [amount, setAmount] = useState('');
  const [remark, setRemark] = useState('');
  const [kind, setKind] = useState<'income' | 'expense'>('income');
  const [saving, setSaving] = useState(false);
  const [exporting, setExporting] = useState(false);
  const [removing, setRemoving] = useState(false);
  const [loading, setLoading] = useState(true);
  const [loadError, setLoadError] = useState('');
  const loadSequence = useRef(0);
  const savingRef = useRef(false);
  const removingRef = useRef(false);
  const exportingRef = useRef(false);

  const load = useCallback(async () => {
    const sequence = ++loadSequence.current;
    setLoading(true);
    setLoadError('');
    try {
      const data = await getLedger(dateBounds(range.from, range.to));
      if (sequence !== loadSequence.current) return;
      setList(data);
      setSelected(current => current ? data.find(entry => entry.id === current.id) || current : null);
    } catch (error) {
      if (sequence === loadSequence.current) setLoadError(error instanceof Error ? error.message : 'LOAD_FAILED');
    } finally {
      if (sequence === loadSequence.current) setLoading(false);
    }
  }, [range]);

  useSharedRefresh(load);
  useEffect(() => { void load(); }, [load]);
  useEffect(() => () => { loadSequence.current += 1; }, []);
  useEffect(() => {
    if (!scrollTarget) return;
    const timer = setTimeout(() => setScrollTarget(''), 500);
    return () => clearTimeout(timer);
  }, [scrollTarget]);
  useEffect(() => {
    if (typeof document === 'undefined') return;
    const close = (event: KeyboardEvent) => {
      if (event.key !== 'Escape' || saving || removing || photoBusy) return;
      setShow(false); setSelected(null); setRangeOpen(false);
    };
    document.addEventListener('keydown', close);
    return () => document.removeEventListener('keydown', close);
  }, [saving, removing, photoBusy]);

  const changePhotoDrafts = useCallback((id: number, update: (items: PhotoDraft[]) => PhotoDraft[]) => {
    setPhotoDrafts(current => ({ ...current, [id]: update(current[id] || []) }));
  }, []);
  const photoSaved = useCallback((id: number, attachment: LedgerAttachment) => {
    const update = (entry: LedgerEntry) => entry.id === id && !entry.attachments?.some(item => item.id === attachment.id) ? { ...entry, attachments: [...(entry.attachments || []), attachment] } : entry;
    setList(current => current.map(update));
    setSelected(current => current ? update(current) : current);
  }, []);

  const totals = useMemo(() => summarizeLedger(list), [list]);
  const filtered = useMemo(() => filterLedger(list, type, keyword), [list, type, keyword]);
  const groups = useMemo(() => groupLedger(filtered), [filtered]);
  const amountPreview = useMemo(() => previewMoneyInput(amount), [amount]);
  const openEntry = useCallback((entry: LedgerEntry) => setSelected(entry), []);
  const ready = !loading && !loadError;
  const money = (value: number) => ready ? formatMoney(value) : '—';
  const dateLabel = range.from && range.to ? `${range.from.replace(/-/g, '.')} — ${range.to.replace(/-/g, '.')}` : '查看全部记账日期';
  const selectCategory = (value: LedgerType) => {
    setType(value); setKeyword(''); setScrollTarget('ledger-detail-list');
  };

  const choosePeriod = (value: string) => {
    setPeriod(value);
    setRange(value === '全部时间' ? { from: '', to: '' } : monthRange(value === '上月' ? -1 : 0));
  };
  const applyRange = () => {
    if (!draftRange.from || !draftRange.to) { setRangeError('请选择开始日期和结束日期'); return; }
    if (draftRange.from > draftRange.to) { setRangeError('开始日期不能晚于结束日期'); return; }
    setRange(draftRange); setPeriod('自定义'); setRangeOpen(false);
  };
  const save = async () => {
    if (savingRef.current) return;
    let value: number;
    try { value = parseMoneyInput(amount, '金额', true); }
    catch (error) { Taro.showToast({ title: error instanceof Error ? error.message : '金额必须大于 0', icon: 'none' }); return; }
    savingRef.current = true;
    setSaving(true);
    try {
      await addLedger({ type: kind, amount: value, remark: remark.trim() });
      setAmount(''); setRemark(''); setShow(false);
      // A new entry is dated now. Reveal it even when viewing an older period.
      setKeyword(''); setType(''); setPeriod('本月'); setRange(monthRange());
      Taro.showToast({ title: '流水保存成功', icon: 'success' });
    } catch (error) { Taro.showToast({ title: error?.message || '流水保存失败', icon: 'none' }); }
    finally { savingRef.current = false; setSaving(false); }
  };
  const remove = useCallback(async (entry: LedgerEntry) => {
    if (removingRef.current || isLinkedEntry(entry)) return;
    removingRef.current = true;
    setRemoving(true);
    try {
      const result = await Taro.showModal({ title: '作废这笔流水？', content: '作废后保留历史记录，不再计入汇总。' + (entry.party_id ? '作废后将同步恢复对应客户/供应商的往来余额。' : '') + '此操作不能撤销。', confirmText: '确认作废', confirmColor: '#b74949' });
      if (!result.confirm) return;
      await deleteLedger(entry.id);
      setSelected(null);
      Taro.showToast({ title: '流水已作废', icon: 'success' });
      await load();
    } catch (error) { Taro.showToast({ title: error?.message || '流水作废失败', icon: 'none' }); }
    finally { removingRef.current = false; setRemoving(false); }
  }, [load]);
  const exportCsv = async () => {
    if (exportingRef.current || !ready || filtered.length === 0) return;
    exportingRef.current = true;
    setExporting(true);
    try {
      const bounds = dateBounds(range.from, range.to);
      const params = new URLSearchParams();
      if (type) params.set('type', type);
      if (keyword.trim()) params.set('keyword', keyword.trim());
      if (bounds.from !== undefined) params.set('from', String(bounds.from));
      if (bounds.to !== undefined) params.set('to', String(bounds.to));
      await downloadCsv(`/api/export/ledger.csv${params.toString() ? `?${params}` : ''}`, 'warehouse-ledger.csv');
    } catch (error) { Taro.showToast({ title: error?.message || '导出失败', icon: 'none' }); }
    finally { exportingRef.current = false; setExporting(false); }
  };

  return <View className={styles.page}>
    <ScrollView scrollY={!show && !selected && !rangeOpen} scrollIntoView={scrollTarget} className={styles.scroll} refresherEnabled refresherTriggered={loading} onRefresherRefresh={load}>
      <View className={styles.content}>
        <View className={styles.header}>
          <View className={styles.headingGroup}>
            <Button className={styles.back} aria-label='返回' onClick={() => Taro.getCurrentPages().length > 1 ? Taro.navigateBack() : Taro.switchTab({ url: '/pages/mine/index' })}><Icon name='chevron' color='#34483e' /></Button>
            <View><Text className={styles.eyebrow}>曙光库存 · 账务管理</Text><Text className={styles.title}>账单流水</Text></View>
          </View>
          <Button className={styles.export} disabled={!ready || exporting || filtered.length === 0} onClick={exportCsv}><Icon name='download' color='#426051' /><Text>{exporting ? '导出中…' : '导出 CSV'}</Text></Button>
        </View>

        <View className={styles.periodBar}>
          <View className={styles.periodTabs}>{['本月', '上月', '全部时间'].map(value => <Button key={value} className={`${styles.periodTab} ${period === value ? styles.periodActive : ''}`} onClick={() => choosePeriod(value)}>{value}</Button>)}</View>
          <Button className={`${styles.rangeButton} ${period === '自定义' ? styles.rangeActive : ''}`} onClick={() => { setDraftRange(range); setRangeError(''); setRangeOpen(true); }}><Icon name='clock' color='#738176' /><Text>{period === '自定义' ? '已选日期' : '选日期'}</Text><Icon name='chevron' color='#738176' /></Button>
        </View>

        <View className={styles.workspace}>
        <View className={styles.overviewPanel}>
        <View className={styles.summary}>
          <View className={styles.summaryTop}><Text>{period}收支净额</Text><Text className={styles.summaryTag}>{period === '自定义' ? '自选日期' : range.from ? range.from.slice(0, 7).replace('-', '.') : '全部日期'}</Text></View>
          <View className={styles.netAmount}>{ready && <Text className={styles.netCurrency}>¥</Text>}<Text className={styles.netValue}>{ready ? formatMoney(totals.net).slice(1) : '—'}</Text></View>
          <Text className={`${styles.summaryDate} ${period === '自定义' ? styles.customSummaryDate : ''}`}>{dateLabel}</Text>
          <View className={styles.cashGrid}>
            <View><View className={styles.cashLabel}><View className={styles.cashArrow}><Icon name='inbound' color='#c6eadb' /></View><Text>收入</Text></View><Text className={styles.cashAmount}>{money(totals.income)}</Text></View>
            <View><View className={styles.cashLabel}><View className={styles.cashArrow}><Icon name='outbound' color='#ead9b9' /></View><Text>支出</Text></View><Text className={styles.cashAmount}>{money(totals.expense)}</Text></View>
          </View>
        </View>
        <View className={styles.accruals}>
          {(['receivable', 'payable', 'settlement'] as const).map(value => <Button className={`${styles.accrual} ${type === value ? styles.accrualActive : ''}`} key={value} aria-label={`筛选${types.find(item => item.value === value)?.label}流水`} aria-pressed={type === value} onClick={() => selectCategory(value)}><View className={styles.accrualHeading}><Text className={styles.accrualLabel}>{value === 'receivable' ? '期间应收' : value === 'payable' ? '期间应付' : '期间结清'}</Text><Icon name='chevron' color='#93a499' /></View><Text className={styles.accrualAmount}>{money(totals[value])}</Text></Button>)}
        </View>
        <View className={styles.summaryNote}><Icon name='clipboard' color='#8c9b91' /><Text>应收、应付与结清不计入收支净额</Text></View>
        <View className={styles.autoNote}><View className={styles.autoNoteIcon}><Icon name='check' color='#28785f' /></View><View><Text className={styles.autoNoteTitle}>出库后，应收自动入账</Text><Text className={styles.autoNoteText}>关联客户的出库金额会同步到这里。</Text></View><Button className={styles.autoNoteAction} aria-label='查看应收流水' onClick={() => selectCategory('receivable')}><Icon name='chevron' color='#6a8b78' /></Button></View>
        </View>

        <View className={styles.listPanel} id='ledger-detail-list'>
          <View className={styles.listControls}>
          <View className={styles.listHeading}><View><Text className={styles.sectionTitle}>流水明细</Text><Text className={styles.recordCount}>{ready ? `${filtered.length} 笔` : '—'}</Text></View><Button className={styles.refresh} disabled={loading} onClick={load}>{loading ? '更新中' : '刷新'}</Button></View>
          <View className={styles.search}><Icon name='search' color='#99a39d' /><Input placeholder='搜索客户、供应商或备注' value={keyword} maxlength={100} onInput={e => setKeyword(e.detail.value)} /><Button className={styles.clearSearch} aria-label='清空搜索' onClick={() => setKeyword('')} style={{ visibility: keyword ? 'visible' : 'hidden' }}>×</Button></View>
          <View className={styles.typeTabs}>{types.map(item => <Button className={`${styles.typeTab} ${type === item.value ? styles.typeActive : ''}`} aria-pressed={type === item.value} key={item.value || 'all'} onClick={() => setType(item.value)}>{item.label}</Button>)}</View>
          {(type || keyword.trim()) && <View className={styles.filterStatus}><Text>{type ? `${types.find(item => item.value === type)?.label}流水` : '全部类型'}{keyword.trim() ? ` · “${keyword.trim()}”` : ''}</Text><Button onClick={() => { setType(''); setKeyword(''); }}>重置</Button></View>}
          </View>
          {loading ? <View className={styles.empty}><View className={styles.loadingDot} /><Text className={styles.emptyTitle}>正在加载账单</Text><Text>稍等一下，正在同步流水…</Text></View>
            : loadError ? <View className={styles.empty}><Icon name='alert' color='#b7763b' /><Text className={styles.emptyTitle}>账单暂时没有加载成功</Text><Text>{loadError === 'LOAD_FAILED' ? '请检查网络后重试' : loadError}</Text><Button className={styles.emptyAction} onClick={load}>重新加载</Button></View>
              : filtered.length === 0 ? <View className={styles.empty}><Icon name='records' color='#a4b8ac' /><Text className={styles.emptyTitle}>{type || keyword ? '没有找到匹配的流水' : '这段时间还没有流水'}</Text><Text>{type || keyword ? '试试其他关键词，或清除筛选' : '可以换个日期，或记下第一笔收支'}</Text><Button className={styles.emptyAction} onClick={() => { if (type || keyword) { setType(''); setKeyword(''); } else setShow(true); }}>{type || keyword ? '清除筛选' : '记一笔'}</Button></View>
                : groups.map(group => <View className={styles.dayGroup} key={group.date}>
                  <View className={styles.dayHeading}><Text>{dayLabel(group.date)}<Text className={styles.weekday}>周{'日一二三四五六'[new Date(`${group.date}T00:00:00`).getDay()]}</Text></Text><Text>{group.entries.length} 笔</Text></View>
                  {group.entries.map(entry => <LedgerListRow key={entry.id} entry={entry} onOpen={openEntry} />)}
                </View>)}
          {ready && filtered.length > 0 && <Text className={styles.listEnd}>已显示当前筛选下的全部流水</Text>}
        </View>
        </View>
      </View>
    </ScrollView>

    <View className={styles.bottomBar}><View className={styles.bottomInner}><View className={styles.bottomCopy}><View className={styles.connectionDot} /><View><Text className={styles.bottomTitle}>出库应收自动同步</Text><Text className={styles.bottomHint}>日常收支可以手动补记</Text></View></View><Button className={styles.add} onClick={() => { setSelected(null); setShow(true); }}><Icon name='plus' color='#fff' /><Text>记一笔</Text></Button></View></View>

    {rangeOpen && <View className={styles.overlay} onClick={() => setRangeOpen(false)}><View className={styles.sheet} role='dialog' aria-modal='true' aria-label='筛选日期' onClick={e => e.stopPropagation()}>
      <View className={styles.sheetHeader}><Text>筛选日期</Text><Button className={styles.close} aria-label='关闭日期筛选' onClick={() => setRangeOpen(false)}>×</Button></View>
      <Text className={styles.sheetDescription}>按记账日期查看，包含开始和结束当天。</Text>
      <View className={styles.dateFields}><View><Text className={styles.fieldLabel}>开始日期</Text><Picker mode='date' value={draftRange.from} onChange={e => { setDraftRange({ ...draftRange, from: e.detail.value }); setRangeError(''); }}><View className={styles.datePicker}>{draftRange.from || '请选择日期'}</View></Picker></View><Text className={styles.dateSeparator}>—</Text><View><Text className={styles.fieldLabel}>结束日期</Text><Picker mode='date' value={draftRange.to} onChange={e => { setDraftRange({ ...draftRange, to: e.detail.value }); setRangeError(''); }}><View className={styles.datePicker}>{draftRange.to || '请选择日期'}</View></Picker></View></View>
      {rangeError && <Text className={styles.formError}>{rangeError}</Text>}
      <Button className={styles.save} onClick={applyRange}>应用日期</Button>
    </View></View>}

    {show && <View className={styles.overlay} onClick={() => { if (!saving) setShow(false); }}><View className={styles.sheet} role='dialog' aria-modal='true' aria-label='记一笔' onClick={e => e.stopPropagation()}>
      <View className={styles.sheetHeader}><Text>记一笔</Text><Button className={styles.close} aria-label='关闭新增流水' disabled={saving} onClick={() => setShow(false)}>×</Button></View>
      <Text className={styles.sheetDescription}>记录一笔日常收入或支出。</Text>
      <View className={styles.kindTabs}>{(['income', 'expense'] as const).map(value => <Button key={value} className={`${styles.kindTab} ${kind === value ? styles.kindActive : ''}`} disabled={saving} onClick={() => setKind(value)}><Icon name={appearance[value].icon} color={kind === value ? '#167c60' : '#849189'} />{value === 'income' ? '收入' : '支出'}</Button>)}</View>
      <Text className={styles.fieldLabel}>金额</Text><View className={styles.amountField}><Text>¥</Text><Input type='digit' placeholder='0.00' value={amount} disabled={saving} onInput={e => setAmount(sanitizeNonNegativeMoneyInput(e.detail.value))} /></View>
      <Text className={styles.remark}>本次金额预览 {amountPreview === null ? '—' : formatMoney(amountPreview)}</Text>
      <View className={styles.remarkLabel}><Text className={styles.fieldLabel}>备注</Text><Text>选填 · {remark.length}/200</Text></View><Input className={styles.remarkInput} placeholder='例如：客户货款、运费、日常采购' value={remark} maxlength={200} disabled={saving} onInput={e => setRemark(e.detail.value)} />
      <View className={styles.remarkPresets}>{(kind === 'income' ? ['客户货款', '其他收入'] : ['运输费', '日常采购', '办公支出']).map(value => <Button key={value} disabled={saving} onClick={() => setRemark(value)}>{value}</Button>)}</View>
      <Text className={styles.formHint}>保存后可在流水详情添加单据照片。应收、应付与结清记录由对应业务生成。</Text>
      <Button className={styles.save} disabled={saving} onClick={save}>{saving ? '保存中…' : '保存流水'}</Button>
    </View></View>}

    {selected && <View className={styles.overlay} onClick={() => { if (!removing && !photoBusy) setSelected(null); }}><View className={styles.sheet} role='dialog' aria-modal='true' aria-label='流水详情' onClick={e => e.stopPropagation()}>
      <View className={`${styles.sheetHeader} ${styles.detailHeader}`}><Text>流水详情</Text><Button className={styles.close} aria-label='关闭流水详情' disabled={removing || photoBusy} onClick={() => setSelected(null)}>×</Button></View>
      <View className={styles.detailHero}><View className={`${styles.entryIcon} ${styles[selected.type]}`}><Icon name={appearance[selected.type].icon} color={appearance[selected.type].color} /></View><Text className={styles.detailType}>{entryCategory(selected)} · {selected.party_name || '日常记账'}</Text><Text className={`${styles.detailAmount} ${styles[`${selected.type}Text`]}`}>{amountPrefix(selected.type)}{formatMoney(selected.amount)}</Text><View className={styles.detailStatus}><Icon name='check' color='#56856c' /><Text>已入账</Text></View></View>
      <View className={styles.detailRows}>
        <View><Text>流水编号</Text><Text>LS-{String(selected.id).padStart(6, '0')}</Text></View>
        <View><Text>记账时间</Text><Text>{formatTime(selected.created_at)}</Text></View>
        <View><Text>往来对象</Text><Text>{selected.party_name || '未关联对象'}</Text></View>
        {selected.party_current_name && selected.party_current_name !== selected.party_name && <View><Text>对象现名</Text><Text>{selected.party_current_name}</Text></View>}
        <View><Text>记录来源</Text><Text>{selected.transaction_id ? `出入库记录 #${selected.transaction_id}` : selected.delivery_note_id ? `送货单 #${selected.delivery_note_id}` : selected.party_id ? '客户 / 供应商往来' : '手动记账'}</Text></View>
        <View><Text>备注说明</Text><Text>{selected.remark || '未填写备注'}</Text></View>
      </View>
      <LedgerAttachments key={selected.id} entry={selected} drafts={photoDrafts[selected.id] || []} onDrafts={changePhotoDrafts} onSaved={photoSaved} onBusy={setPhotoBusy} />
      {isLinkedEntry(selected) ? <Text className={styles.linkedNote}>此流水关联业务单据，如需调整，请前往原业务处理。</Text> : <Button className={styles.voidButton} disabled={removing || photoBusy} onClick={() => remove(selected)}>{removing ? '处理中…' : '作废流水'}</Button>}
    </View></View>}
  </View>;
}
