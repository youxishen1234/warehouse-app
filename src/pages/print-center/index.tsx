/* eslint-disable react/forbid-elements */
import { useCallback, useEffect, useRef, useState } from 'react';
import Taro, { useRouter } from '@tarojs/taro';
import { getCustomer, getCustomers, getTransactions } from '@/services/api';
import { getPrintNote, getPrintNotes, savePrintNote, shipPrintNote } from '@/services/print-notes';
import type { PrintNoteInput, SavedPrintNote } from '@/services/print-notes';
import type { Customer } from '@/types';
import { documentFromTransactions, moneyUpper, transactionPrintKey } from '@/utils/dot-matrix-print';
import { previewAmount } from '@/utils/stock-math';
import { useSharedRefresh } from '@/services/shared-refresh';
import { session, watchSession } from '@/services/session';
import { blankItem, draftFromTransactions, draftTotal, newNote, normalizeSpecification, noteDraft, selectCustomer, validateDraft } from './model';
import type { ItemDraft, NoteDraft } from './model';
import PrintPreview from './preview';
import styles from './index.module.scss';

const currency = (value: number) => Number.isFinite(value) ? value.toLocaleString('zh-CN', { minimumFractionDigits: 2, maximumFractionDigits: 2 }) : '—';
const messageOf = (error: unknown) => error instanceof Error ? error.message : '暂时无法完成，请重试';

export default function PrintCenterPage() {
  const { params } = useRouter();
  const [draft, setDraft] = useState<NoteDraft>(newNote);
  const [saved, setSaved] = useState<SavedPrintNote>();
  const [dirty, setDirty] = useState(false);
  const [tab, setTab] = useState<'edit' | 'history' | 'detail'>('edit');
  const [preview, setPreview] = useState<PrintNoteInput>();
  const [busy, setBusy] = useState(false);
  const busyRef = useRef(false);
  const [error, setError] = useState('');
  const [notice, setNotice] = useState('');
  const [shipBusy, setShipBusy] = useState(false);
  const errorBox = useRef<HTMLDivElement>(null);
  const [customerOpen, setCustomerOpen] = useState(false);
  const [customerQuery, setCustomerQuery] = useState('');
  const [customers, setCustomers] = useState<Customer[]>([]);
  const [customerLoading, setCustomerLoading] = useState(false);
  const [customerError, setCustomerError] = useState('');
  const [customerRetry, setCustomerRetry] = useState(0);
  const [chosenCustomer, setChosenCustomer] = useState<Customer>();
  const [query, setQuery] = useState('');
  const [history, setHistory] = useState<SavedPrintNote[]>([]);
  const [historyLoading, setHistoryLoading] = useState(false);
  const [historyError, setHistoryError] = useState('');
  const [totalRecords, setTotalRecords] = useState(0);
  const [historyPage, setHistoryPage] = useState(1);
  const historySequence = useRef(0);
  const [confirmDiscard, setConfirmDiscard] = useState(false);
  const pendingNavigation = useRef<(() => void) | null>(null);

  const change = (patch: Partial<NoteDraft>) => { setDraft(previous => ({ ...previous, ...patch })); setDirty(true); setError(''); setNotice(''); };
  const changeItem = (key: string, patch: Partial<ItemDraft>) => { setDraft(previous => ({ ...previous, items: previous.items.map(item => item.key === key ? { ...item, ...patch } : item) })); setDirty(true); setError(''); setNotice(''); };
  const guard = (action: () => void) => {
    if (busyRef.current) return;
    if (!dirty) { action(); return; }
    pendingNavigation.current = action; setConfirmDiscard(true);
  };
  const startNew = () => guard(() => { setDraft(newNote()); setSaved(undefined); setChosenCustomer(undefined); setDirty(false); setTab('edit'); setError(''); setNotice(''); });
  const back = () => guard(() => { if (Taro.getCurrentPages().length > 1) void Taro.navigateBack(); else void Taro.switchTab({ url: '/pages/home/index' }); });

  useEffect(() => {
    if (error) errorBox.current?.scrollIntoView({ block: 'center', behavior: 'smooth' });
  }, [error]);
  useEffect(() => {
    const warn = (event: BeforeUnloadEvent) => { if (dirty) { event.preventDefault(); event.returnValue = ''; } };
    window.addEventListener('beforeunload', warn);
    return () => window.removeEventListener('beforeunload', warn);
  }, [dirty]);

  useEffect(() => {
    if (!customerOpen) return;
    let active = true;
    setCustomerLoading(true); setCustomerError(''); setCustomers([]);
    const timer = setTimeout(() => {
      getCustomers(customerQuery.trim()).then(list => { if (active) setCustomers(list.filter(customer => !customer.deleted_at)); })
        .catch(issue => { if (active) setCustomerError(messageOf(issue)); })
        .finally(() => { if (active) setCustomerLoading(false); });
    }, 220);
    return () => { active = false; clearTimeout(timer); };
  }, [customerQuery, customerOpen, customerRetry]);

  const loadHistory = useCallback(async (page = 1) => {
    const current = ++historySequence.current;
    setHistoryLoading(true); setHistoryError('');
    try {
      const result = await getPrintNotes(query, page);
      if (current !== historySequence.current) return;
      setHistory(previous => page === 1 ? result.items : [...previous, ...result.items]);
      setHistoryPage(page); setTotalRecords(result.total);
    } catch (issue) { if (current === historySequence.current) setHistoryError(messageOf(issue)); }
    finally { if (current === historySequence.current) setHistoryLoading(false); }
  }, [query]);
  useEffect(() => {
    if (tab !== 'history') return;
    setHistory([]); setTotalRecords(0); setHistoryLoading(true);
    const timer = setTimeout(() => void loadHistory(), 220);
    const requestSequence = historySequence;
    return () => { clearTimeout(timer); requestSequence.current++; };
  }, [tab, loadHistory]);
  const refresh = useCallback(() => { if (tab === 'history') void loadHistory(); }, [tab, loadHistory]);
  useSharedRefresh(refresh);

  // Preserve links from outbound/records, loading every line of the selected document.
  useEffect(() => {
    const id = params.transaction_id;
    if (!id || !/^d+$/.test(id)) return;
    let active = true, started = false; busyRef.current = true; setBusy(true); setError('');
    const load = async () => {
      if (started || !session()) return;
      started = true;
      try {
        const records = await getTransactions({ include_voided: true });
        const first = records.find(row => row.id === Number(id));
        if (!first) throw new Error('原单据不存在，请返回重新选择');
        const lines = records.filter(row => transactionPrintKey(row) === transactionPrintKey(first));
        documentFromTransactions(lines);
        const customer = first.customer_id ? await getCustomer(first.customer_id) : undefined;
        if (active) { setDraft(draftFromTransactions(lines, customer)); setChosenCustomer(customer); setDirty(true); setNotice('已带入原单明细，核对后即可保存送货单'); }
      } catch (issue) { if (active) setError(messageOf(issue)); }
      finally { if (active) { busyRef.current = false; setBusy(false); } }
    };
    const stop = watchSession(() => void load());
    void load(); return () => { active = false; stop(); };
  }, [params.transaction_id]);

  const openNote = (id: number) => guard(() => {
    busyRef.current = true; setBusy(true); setError(''); setNotice('');
    getPrintNote(id).then(note => { setSaved(note); setDraft(noteDraft(note)); setDirty(false); setChosenCustomer(undefined); setTab('detail'); })
      .catch(issue => setError(messageOf(issue))).finally(() => { busyRef.current = false; setBusy(false); });
  });
  const save = async () => {
    if (busyRef.current) return;
    let data: PrintNoteInput;
    try { data = validateDraft(draft); } catch (issue) { setError(messageOf(issue)); return; }
    busyRef.current = true; setBusy(true); setError('');
    try {
      const note = await savePrintNote(data, saved);
      setSaved(note); setDraft(noteDraft(note)); setDirty(false); setNotice(saved ? '修改已保存' : '送货单已保存');
    } catch (issue) { setError(messageOf(issue)); }
    finally { busyRef.current = false; setBusy(false); }
  };
  const showPreview = () => { try { setPreview(validateDraft(draft)); setError(''); } catch (issue) { setError(messageOf(issue)); } };
  const shipAndPrint = async () => {
    if (!saved || shipBusy || dirty) { if (dirty) setError('请先保存送货单，再确认出库'); return; }
    setShipBusy(true); setError('');
    try {
      const note = await shipPrintNote(saved.id);
      setSaved(note); setDraft(noteDraft(note)); setNotice('已出库，库存和客户应收已更新；现在打开打印预览');
      setPreview(note);
    } catch (issue) { setError(messageOf(issue)); }
    finally { setShipBusy(false); }
  };
  const chooseCustomer = (customer: Customer) => {
    setDraft(previous => selectCustomer(previous, customer)); setChosenCustomer(customer); setCustomerOpen(false); setDirty(true); setError(''); setNotice('');
  };
  const addItem = (item = blankItem()) => { if (draft.items.length < 200) change({ items: [...draft.items, item] }); };
  const amount = draftTotal(draft);
  const input = (key: keyof Omit<NoteDraft, 'items' | 'customer_id' | 'paper'>, label: string, limit: number, type = 'text') => <label className={styles.field}>{label}<input aria-label={label} type={type} value={draft[key]} maxLength={limit} onChange={event => change({ [key]: event.target.value })} /></label>;

  return <main className={styles.page}>
    <div className={styles.shell}>
      <header className={styles.toolbar}><button type='button' className={styles.back} aria-label='返回' onClick={back}>‹</button><div><h1>打印中心</h1><p>送货单</p></div><button type='button' className={styles.newButton} onClick={startNew} disabled={busy}>＋ 新建</button></header>
      <nav className={styles.tabs} aria-label='打印中心页面'><button type='button' aria-pressed={tab !== 'history'} onClick={() => setTab(saved && !dirty ? 'detail' : 'edit')}>当前单据</button><button type='button' aria-pressed={tab === 'history'} onClick={() => setTab('history')}>历史单据</button></nav>
      {error && <div ref={errorBox} className={styles.error} role='alert'>{error}</div>}
      {notice && <div className={styles.notice} role='status'>{notice}</div>}
      {tab === 'history' ? <section className={styles.history}>
        <div className={styles.historySearch}><input type='search' aria-label='搜索历史单据' placeholder='搜索客户、单号、商品或规格' value={query} onChange={event => setQuery(event.target.value)} /><button type='button' onClick={() => void loadHistory()} disabled={historyLoading}>刷新</button></div>
        {historyError && <div role='alert' className={styles.error}>{historyError}<button type='button' onClick={() => void loadHistory()}>重试</button></div>}
        {!history.length && !historyLoading && !historyError && <div className={styles.empty}><strong>{query ? '没有找到单据' : '还没有送货单'}</strong><p>{query ? '换个客户名称、单号或规格试试' : '新建第一张，之后随时查看和修改'}</p>{!query && <button type='button' onClick={startNew}>新建送货单</button>}</div>}
        {history.map(note => <button type='button' className={styles.historyCard} key={note.id} disabled={busy} onClick={() => openNote(note.id)}><span><strong>{note.customer_name}</strong><small>{note.date} · {note.items.length} 项</small><small>{note.number}</small><span className={styles.historyItems}>{note.items.map(item => item.name).join('、')}</span></span><span className={styles.historyAmount}>¥ {currency(note.total)}<small>查看详情 ›</small></span></button>)}
        {historyLoading && <p className={styles.muted} role='status'>正在加载单据…</p>}
        {!historyLoading && history.length < totalRecords && <button type='button' className={styles.addButton} onClick={() => void loadHistory(historyPage + 1)}>加载更多</button>}
      </section> : tab === 'detail' && saved ? <>
        <section className={styles.card}><div className={styles.sectionHeading}><h2>单据详情</h2><span className={styles.saved}>已保存</span></div><h3>{saved.customer_name}</h3><p className={styles.muted}>{saved.number} · {saved.date}</p><dl className={styles.details}><dt>收货地址</dt><dd>{saved.address || '未填写'}</dd><dt>收货人</dt><dd>{saved.receiver || '未填写'}{saved.phone ? ` · ${saved.phone}` : ''}</dd><dt>送货人</dt><dd>{saved.sender || '未填写'}</dd><dt>公司抬头</dt><dd>{saved.company}</dd></dl></section>
        <section className={styles.card}><div className={styles.sectionHeading}><h2>货物明细</h2><span>{saved.items.length} 项</span></div>{saved.items.map((item, index) => <div key={index} className={styles.detailItem}><div><strong>{index + 1}. {item.name}</strong><span>{item.specification || '未填规格'} · {item.quantity} 个 × ¥ {item.price}</span>{item.remark && <small>{item.remark}</small>}</div><strong>¥ {currency(item.amount)}</strong></div>)}<div className={styles.total}><span>合计</span><strong>¥ {currency(saved.total)}</strong></div><p className={styles.upper}>{moneyUpper(saved.total)}</p></section>
        <footer className={styles.actions}><button type='button' className={styles.secondary} onClick={() => { setTab('edit'); setNotice(''); }} disabled={!!saved.outbound_at}>编辑单据</button>{saved.outbound_at ? <button type='button' className={styles.primary} onClick={showPreview}>再次打印</button> : <button type='button' className={styles.primary} onClick={shipAndPrint} disabled={shipBusy || dirty}>{shipBusy ? '出库中…' : '确认出库并打印'}</button>}</footer>
      </> : <>
        <div className={styles.documentStatus}><span>{saved?.number || '新送货单'}</span><span>{busy ? '正在处理…' : dirty ? '待保存' : saved ? '已保存' : '填写后保存'}</span></div>
        <fieldset disabled={busy} className={styles.form}>
          <section className={styles.card}><div className={styles.sectionHeading}><h2>收货信息</h2><button type='button' className={styles.textButton} onClick={() => { setCustomerQuery(''); setCustomerOpen(true); }}>搜索客户</button></div>
            <label className={styles.field}>收货单位<input aria-label='收货单位' placeholder='输入名称，或点右上角搜索客户' maxLength={100} value={draft.customer_name} onChange={event => { change({ customer_name: event.target.value, customer_id: null }); setChosenCustomer(undefined); }} /></label>
            {input('address', '收货地址', 200)}
            <div className={styles.grid}>{input('receiver', '收货人', 50)}{input('phone', '联系电话', 30, 'tel')}{input('date', '送货日期', 10, 'date')}{input('sender', '送货人', 50)}</div>
          </section>
          <section className={styles.card}><div className={styles.sectionHeading}><h2>货物明细</h2><span>单位：个</span></div>
            {!!chosenCustomer?.specs?.length && <label className={styles.field}>客户常用规格<select aria-label='选择客户常用规格' value='' onChange={event => { const spec = chosenCustomer.specs?.find(row => row.id === event.target.value); if (!spec) return; const item = { ...blankItem(), name: spec.goods, specification: normalizeSpecification(spec.specification), price: String(spec.price) }; if (draft.items.length === 1 && !draft.items[0].name && !draft.items[0].quantity && !draft.items[0].specification) change({ items: [item] }); else addItem(item); }}><option value=''>选择规格，自动填入商品和单价</option>{chosenCustomer.specs.map(spec => <option key={spec.id} value={spec.id}>{spec.goods} · {normalizeSpecification(spec.specification)}</option>)}</select></label>}
            <div className={styles.items}>{draft.items.map((item, index) => <article className={styles.item} key={item.key}>
              <div className={styles.itemHeading}><span>货物 {String(index + 1).padStart(2, '0')}</span><button type='button' className={styles.removeButton} aria-label={`删除第${index + 1}项`} disabled={draft.items.length === 1} onClick={() => change({ items: draft.items.filter(row => row.key !== item.key) })}>删除</button></div>
              <div className={styles.grid}><label className={styles.field}>产品名称<input aria-label={`第${index + 1}项产品名称`} placeholder='如：瓦楞纸箱' value={item.name} maxLength={100} onChange={event => changeItem(item.key, { name: event.target.value })} /></label><label className={styles.field}>规格尺寸<input aria-label={`第${index + 1}项规格尺寸`} placeholder='400×300×200' value={item.specification} maxLength={100} onChange={event => changeItem(item.key, { specification: event.target.value })} onBlur={() => changeItem(item.key, { specification: normalizeSpecification(item.specification) })} /></label><label className={styles.field}>数量（个）<input aria-label={`第${index + 1}项数量`} inputMode='decimal' placeholder='填写数量' value={item.quantity} maxLength={18} onChange={event => changeItem(item.key, { quantity: event.target.value })} /></label><label className={styles.field}>单价（元）<input aria-label={`第${index + 1}项单价`} inputMode='decimal' placeholder='0.00' value={item.price} maxLength={18} onChange={event => changeItem(item.key, { price: event.target.value })} /></label></div>
              <label className={styles.field}>备注<input aria-label={`第${index + 1}项备注`} placeholder='选填' maxLength={250} value={item.remark} onChange={event => changeItem(item.key, { remark: event.target.value })} /></label><div className={styles.itemAmount}>金额 <strong>¥ {currency(previewAmount(item.quantity, item.price))}</strong></div>
            </article>)}</div>
            <button type='button' className={styles.addButton} disabled={draft.items.length >= 200} onClick={() => addItem()}>＋ 添加货物</button><div className={styles.total}><span>合计 · {draft.items.length} 项</span><strong>¥ {currency(amount)}</strong></div><p className={styles.upper}>{moneyUpper(amount)}</p>
          </section>
          <details className={styles.settings}><summary>公司与纸张 <span>{draft.paper === 'a4' ? 'A4' : draft.paper === '241-140' ? '二等分' : '三等分'}</span></summary><div className={styles.settingsBody}>{input('company', '公司抬头', 50)}<label className={styles.field}>打印纸张<select aria-label='打印纸张' value={draft.paper} onChange={event => change({ paper: event.target.value as NoteDraft['paper'] })}><option value='241-93'>241 × 93 mm · 三等分</option><option value='241-140'>241 × 140 mm · 二等分</option><option value='a4'>A4 · 210 × 297 mm</option></select></label></div></details>
        </fieldset>
        <footer className={styles.actions}><button type='button' className={styles.secondary} disabled={busy || (!!saved && !dirty)} onClick={() => void save()}>{busy ? '保存中…' : saved && !dirty ? '已保存' : '保存单据'}</button><button type='button' className={styles.primary} disabled={busy} onClick={showPreview}>预览打印</button></footer>
      </>}
    </div>
    {customerOpen && <div className={styles.backdrop} onClick={() => setCustomerOpen(false)}><section role='dialog' aria-modal='true' aria-label='搜索客户' className={styles.dialog} onClick={event => event.stopPropagation()}><div className={styles.sectionHeading}><h2>选择客户</h2><button type='button' className={styles.textButton} onClick={() => setCustomerOpen(false)}>关闭</button></div><input autoFocus type='search' aria-label='搜索客户名称或电话' placeholder='客户名称 / 联系人 / 电话' value={customerQuery} onChange={event => setCustomerQuery(event.target.value)} /><div className={styles.customerResults}>{customerLoading ? <p className={styles.muted}>正在查找…</p> : customerError ? <div className={styles.error} role='alert'>{customerError}<button type='button' onClick={() => setCustomerRetry(value => value + 1)}>重试</button></div> : customers.length ? customers.map(customer => <button type='button' className={styles.customer} key={customer.id} onClick={() => chooseCustomer(customer)}><strong>{customer.name}</strong><span>{[customer.contact, customer.phone].filter(Boolean).join(' · ') || '暂无联系人'}</span>{customer.address && <small>{customer.address}</small>}</button>) : <p className={styles.muted}>没有找到客户，可关闭后直接填写收货单位</p>}</div></section></div>}
    {confirmDiscard && <div className={styles.backdrop}><section role='dialog' aria-modal='true' aria-label='保留未保存内容' className={styles.dialog}><h2>当前内容还没有保存</h2><p>离开后，本次修改将不会保留。</p><div className={styles.confirmActions}><button type='button' className={styles.secondary} onClick={() => { setConfirmDiscard(false); pendingNavigation.current = null; }}>继续编辑</button><button type='button' className={styles.primary} onClick={() => { const action = pendingNavigation.current; pendingNavigation.current = null; setConfirmDiscard(false); action?.(); }}>放弃并继续</button></div></section></div>}
    {preview && <PrintPreview note={preview} saved={saved} onClose={() => setPreview(undefined)} />}
  </main>;
}
