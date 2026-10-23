import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { View, Text, Button, Input, Picker } from '@tarojs/components';
import Taro, { useDidHide, useDidShow, useRouter } from '@tarojs/taro';
import Icon, { IconName } from '@/components/Icon';
import CustomerEditor from '@/components/CustomerEditor';
import { addStocktake, getCustomers, getSuppliers, getProducts, getTransactions, getLedger, getOrders, getStats, settleCustomer, settleSupplier } from '@/services/api';
import { getBoards, boardSpec, cartonSpec, today as currentDate } from '@/services/boards';
import { completeProduction, getProduction } from '@/services/business-workflow';
import { useRemoteData } from '@/hooks/useRemoteData';
import { useSharedRefresh } from '@/services/shared-refresh';
import { invalidateProducts, loadProducts } from '@/services/product-store';
import { getCopy } from '@/services/copy';
import { formatMoney, formatTime } from '@/utils/format';
import type { Customer, CustomerOrder, Product, Stats } from '@/types';
import styles from './workbench.module.scss';
import { dailyRecords, localDay, partyMonthSummary, DailyRecord } from './daily-records';

type Panel = 'home' | 'inbound' | 'stock' | 'records' | 'photos' | 'production' | 'supplier' | 'customer';
type WorkbenchProps = {
  embedded?: boolean;
  initial?: Panel;
};
const load = async () => {
  const [boards, products, customers, suppliers, transactions, ledger, production, orders] = await Promise.all([getBoards(), getProducts(), getCustomers(), getSuppliers(), getTransactions(), getLedger(), getProduction(), getOrders()]);
  return { boards, products, customers, suppliers, transactions, ledger, production, orders };
};
const empty = { boards: [], products: [], customers: [], suppliers: [], transactions: [], ledger: [], production: [], orders: [] } as Awaited<ReturnType<typeof load>>;
const open = (url: string) => void (url === '/pages/print-center/index' ? Taro.switchTab({ url }) : Taro.navigateTo({ url }));
const cartonProduct = (p: Product) => p.category !== '纸板' && (p.category === '纸箱' || /\d\s*[×xX*]\s*\d.*[×xX*]/.test(p.specification || ''));
const initialPanel = (section?: string, detail?: string, route = ''): Panel =>
  section === 'customers' ? 'customer'
    : route === '/pages/customers/index' ? 'home'
    : section === 'suppliers' ? 'supplier'
      : section === 'stock' || route === '/pages/inventory/index' ? 'stock'
        : route === '/pages/suppliers/index' ? 'supplier'
        : section === 'records' || detail === '1' ? 'records'
          : 'home';

export default function Workbench({ embedded = false, initial }: WorkbenchProps) {
  const { params, path } = useRouter();
  const remote = useRemoteData(load, empty), { data, reload } = remote;
  const [panel, setPanel] = useState<Panel>(() => initial || initialPanel(params.section, params.detail, path));
  const [stats, setStats] = useState<Stats | null>(null);
  const [lowStock, setLowStock] = useState<Product[]>([]);
  const [kind, setKind] = useState<'board' | 'carton'>('board');
  const [query, setQuery] = useState('');
  const [now, setNow] = useState(new Date());
  const [batchId, setBatchId] = useState('');
  const [productId, setProductId] = useState<number | null>(null);
  const [name, setName] = useState('');
  const [consumed, setConsumed] = useState('');
  const [quantity, setQuantity] = useState('');
  const [remark, setRemark] = useState('');
  const [busy, setBusy] = useState(false), [error, setError] = useState('');
  const [settling, setSettling] = useState<{ party: Customer; supplier: boolean } | null>(null);
  const [editor, setEditor] = useState<{ id?: number; supplier: boolean } | null>(null);
  const [recordView, setRecordView] = useState<'activity' | 'orders'>(() => params.detail === '1' ? 'orders' : 'activity');
  const [orderStatus, setOrderStatus] = useState<'全部' | CustomerOrder['status']>('全部');
  const [amount, setAmount] = useState('');
  const [stocktake, setStocktake] = useState<{ product: Product } | null>(null);
  const [stocktakeValue, setStocktakeValue] = useState('');
  const [stocktakeDate, setStocktakeDate] = useState('');
  const [stocktakeRemark, setStocktakeRemark] = useState('');
  const locked = useRef(false), shown = useRef(false);
  const loadHomeSummary = useCallback(async () => {
    try {
      const [nextStats, products] = await Promise.all([getStats(), loadProducts(true)]);
      setStats(nextStats);
      setLowStock(products.filter(product => Number(product.stock || 0) <= Number(product.safety_stock || 0)).slice(0, 3));
    } catch (loadError) {
      console.error('[Workbench] summary load failed', loadError);
    }
  }, []);
  const refresh = useCallback(() => {
    void reload();
    if (embedded) void loadHomeSummary();
  }, [embedded, loadHomeSummary, reload]);
  useSharedRefresh(refresh);
  useDidShow(() => {
    if (!embedded && typeof document !== 'undefined') document.body.setAttribute('data-simple-workbench-active', '');
    if (shown.current) refresh();
    shown.current = true;
  });
  useDidHide(() => { if (!embedded && typeof document !== 'undefined') document.body.removeAttribute('data-simple-workbench-active'); });
  useEffect(() => { if (embedded) void loadHomeSummary(); }, [embedded, loadHomeSummary]);
  useEffect(() => { const timer = setInterval(() => setNow(new Date()), 1000); return () => clearInterval(timer); }, []);
  useEffect(() => {
    if (embedded || typeof document === 'undefined' || typeof window === 'undefined') return;
    const updateShell = () => {
      const route = window.location.hash.slice(1);
      const routePath = route.split('?')[0];
      const active = routePath === '/pages/business-center/index' || routePath === '/pages/customers/index' || routePath === '/pages/suppliers/index' || routePath === '/pages/inventory/index';
      document.body.toggleAttribute('data-simple-workbench-active', active);
    };
    updateShell();
    window.addEventListener('hashchange', updateShell);
    window.addEventListener('popstate', updateShell);
    return () => { window.removeEventListener('hashchange', updateShell); window.removeEventListener('popstate', updateShell); document.body.removeAttribute('data-simple-workbench-active'); };
  }, [embedded]);

  const batch = data.boards.find(b => b.id === batchId);
  const matches = (value: string) => value.toLowerCase().replace(/[ ×xX*]/g, '').includes(query.toLowerCase().replace(/[ ×xX*]/g, ''));
  const changePanel = (next: Panel) => { setPanel(next); setQuery(''); setError(''); if (next !== 'records') setRecordView('activity'); };
  const action = (label: string, fn: () => void, primary = false) => <Button className={primary ? styles.primary : styles.button} disabled={busy || undefined} onClick={fn}>{label}</Button>;
  const ledgerLink = (supplier: boolean, id?: number) => open('/pages/ledger/index?party_type=' + (supplier ? 'supplier' : 'customer') + (id ? '&party_id=' + id : ''));
  const status = remote.loadError ? '服务器读取失败' : remote.loading ? '正在同步服务器' : '服务器数据已读取 · 多设备自动同步';
  const submitProduction = async () => {
    if (locked.current) return;
    if (!batch) { setError('先选领用的纸板批次'); return; }
    if (!/^\d+$/.test(consumed) || !/^\d+$/.test(quantity) || Number(consumed) <= 0 || Number(quantity) <= 0) { setError('填写本次实际领用张数和合格纸箱数'); return; }
    locked.current = true; setBusy(true); setError('');
    try {
      const record = await completeProduction({ batch_id: batch.id, ...(productId ? { product_id: productId } : { product_name: name }), consumed_quantity: Number(consumed), quantity: Number(quantity), remark });
      invalidateProducts(); setConsumed(''); setQuantity(''); setRemark(''); await reload();
      void Taro.showModal({ title: '完工已保存', content: '纸板减少 ' + record.consumed_quantity + ' 张，纸箱增加 ' + record.quantity + ' ' + record.unit + '。规格和存根已一起保存。', showCancel: false });
    } catch (e) { setError(e instanceof Error ? e.message : '保存失败，请重试'); }
    finally { locked.current = false; setBusy(false); }
  };
  const submitSettlement = async () => {
    if (!settling || locked.current) return;
    if (!/^\d+(\.\d{1,2})?$/.test(amount) || Number(amount) <= 0) { setError('金额请填大于零、最多两位小数'); return; }
    locked.current = true; setBusy(true); setError('');
    try { await (settling.supplier ? settleSupplier : settleCustomer)(settling.party.id, Number(amount), '业务总台结算'); setSettling(null); await reload(); }
    catch (e) { setError(e instanceof Error ? e.message : '结算失败'); }
    finally { locked.current = false; setBusy(false); }
  };
  const openStocktake = (product: Product) => {
    setStocktake({ product }); setStocktakeValue(String(product.stock)); setStocktakeDate(currentDate()); setStocktakeRemark(''); setError('');
  };
  const submitStocktake = async () => {
    if (!stocktake || locked.current) return;
    const value = stocktakeValue.trim();
    if (!/^\d+(?:\.\d{1,6})?$/.test(value) || !Number.isFinite(Number(value))) { setError('实盘库存需为非负数，最多保留 6 位小数'); return; }
    if (!/^\d{4}-\d{2}-\d{2}$/.test(stocktakeDate) || stocktakeDate > currentDate()) { setError('盘点日期无效，且不能晚于今天'); return; }
    locked.current = true; setBusy(true); setError('');
    try {
      await addStocktake({ product_id: stocktake.product.id, counted_stock: Number(value), counted_at: stocktakeDate, remark: stocktakeRemark.trim() });
      setStocktake(null); invalidateProducts(); await reload();
      void Taro.showModal({ title: '盘点已保存', content: '库存和调整流水已同步，盘点记录可在业务记录中查看。', showCancel: false });
    } catch (e) { setError(e instanceof Error ? e.message : '盘点保存失败，请重试'); }
    finally { locked.current = false; setBusy(false); }
  };
  const entries: { title: string; guide: string; icon: IconName; fn: () => void }[] = [
    { title: '入库', guide: '选纸板或纸箱', icon: 'package-plus', fn: () => changePanel('inbound') },
    { title: '生产', guide: '领料并完工', icon: 'factory', fn: () => changePanel('production') },
    { title: '出库', guide: '选客户后发货', icon: 'truck', fn: () => {
      const host = typeof document !== 'undefined' ? document.querySelector<HTMLElement>('taro-tabbar') : null;
      if (host && getComputedStyle(host).display !== 'none') void Taro.switchTab({ url: '/pages/outbound/index' });
      else open('/pages/outbound/index');
    } },
    { title: '收付款', guide: '核对欠款并收付', icon: 'wallet', fn: () => changePanel('customer') }
  ];
  const title = { home: '业务总台', inbound: '入库', stock: '查看库存', records: '业务记录与存根', photos: '票据原件', production: '生产完工', supplier: '供货商账单', customer: '客户账单' }[panel];
  const appName = getCopy('appName');
  const brandCharacter = Array.from(appName.trim())[0] || '曙';
  const day = localDay(now);
  const today = useMemo(() => dailyRecords(data, day).slice(0, 3), [data, day]);
  const visibleOrders = useMemo(() => orderStatus === '全部' ? data.orders : data.orders.filter(order => order.status === orderStatus), [data.orders, orderStatus]);
  // The party bill default is the current calendar month, while the card
  // labels stay explicit because a running current balance is never the same
  // thing as this month's business.
  const yearMonth = `${now.getFullYear()}-${now.getMonth()}`;
  const month = useMemo(() => {
    const reference = new Date(Number(yearMonth.split('-')[0]), Number(yearMonth.split('-')[1]), 1);
    return {
      supplier: partyMonthSummary(data.ledger, true, reference),
      customer: partyMonthSummary(data.ledger, false, reference)
    };
  }, [data.ledger, yearMonth]);
  const monthSuffix = `${now.getMonth() + 1}月`;
  const openRecord = (row: DailyRecord) => {
    if ('board' in row.target) open('/pages/board-detail/index?id=' + encodeURIComponent(row.target.board));
    else if ('ledger' in row.target) open('/pages/ledger/index?entry=' + row.target.ledger);
    else changePanel('records');
  };
  const chooseBatch = (id: string) => { setBatchId(id); setProductId(null); setName(''); setError(''); };
  return <View className={embedded ? `${styles.page} ${styles.embedded}` : styles.page} data-testid='simple-workbench'><View className={styles.surface}>
    <View className={styles.masthead}>
      <View className={styles.header}><View className={styles.heading}>
        {panel === 'home' ? <View className={styles.brand} aria-label={`${appName}标识`} data-testid='workbench-brand'><Text className={styles.brandCharacter}>{brandCharacter}</Text></View> : <Button aria-label='返回总台' className={styles.back} onClick={() => changePanel('home')}>‹</Button>}
        <View className={styles.headingText}><Text className={styles.brandName}>{appName}</Text><Text className={styles.title}>{title}</Text></View>
      </View><Button className={styles.refresh} aria-label='刷新服务器数据' disabled={remote.loading} onClick={refresh}>{remote.loading ? '读取中' : '刷新'}</Button></View>
      <View className={styles.status}><Text>{now.getFullYear()}年{now.getMonth() + 1}月{now.getDate()}日 周{'日一二三四五六'[now.getDay()]}</Text><Text>{now.toLocaleTimeString('zh-CN', { hour12: false })}</Text></View>
    </View>
    <View className={styles.content}>
    {remote.loadError && <View role='alert' className={styles.error}>{remote.loadError}{action('重新读取', () => void reload())}</View>}
    {remote.ready && <View>
      {panel === 'home' && <View>
        {embedded && <View className={styles.summary} data-testid='workbench-summary'>
          <View className={styles.summaryItem}><Text>今日入库</Text><strong>{stats ? stats.todayIn : '--'}</strong></View>
          <View className={styles.summaryItem}><Text>今日出库</Text><strong>{stats ? stats.todayOut : '--'}</strong></View>
          <View className={styles.summaryItem}><Text>库存预警</Text><strong className={lowStock.length ? styles.alertValue : undefined}>{stats ? stats.lowStock : '--'}</strong></View>
        </View>}
        <Text className={styles.sectionTitle}>办理业务</Text>
        <View className={styles.entries} data-testid='workbench-actions'>{entries.map(e => <Button key={e.title} className={styles.entry} onClick={e.fn}>
          <View className={styles.entryTop}><Icon name={e.icon} color='#a6dcb8' strokeWidth={1.5} style={{ width: 21, height: 21 }} /><Text className={styles.entryTitle}>{e.title}</Text><Icon name='chevron' color='#a8b6ad' strokeWidth={1.5} style={{ width: 16, height: 16 }} /></View>
          <View className={styles.entryGuide}><Text className={styles.entryBadge}>怎么用</Text><Text>{e.guide}</Text></View>
        </Button>)}</View>
        <View className={styles.recentHeading}><Text className={styles.sectionTitle}>今天的记录</Text><Button className={styles.textAction} onClick={() => changePanel('records')}>全部记录<Icon name='chevron' color='#a6dcb8' strokeWidth={1.5} style={{ width: 16, height: 16 }} /></Button></View>
        <View data-testid='workbench-today'>{today.map(row => <Button key={row.id} className={styles.activity} onClick={() => openRecord(row)}>
          <Icon name={row.icon} color='#a8b6ad' strokeWidth={1.5} style={{ width: 21, height: 21 }} />
          <View className={styles.activityBody}><Text className={styles.activityTitle}>{row.title}</Text><Text className={styles.activityDetail}>{new Date(row.time).toLocaleTimeString('zh-CN', { hour12: false, hour: '2-digit', minute: '2-digit' })} · {row.detail}</Text></View>
          <View className={styles.activityValue}><Text>{row.money ? formatMoney(row.value) : `${row.value} ${row.unit || ''}`}</Text><Text className={styles.activityStatus}>{row.status}</Text></View>
        </Button>)}{!today.length && <View className={styles.emptyToday}><Icon name='notebook' color='#8a9b8f' strokeWidth={1.5} style={{ width: 28, height: 28 }} /><Text>今天还没有业务记录</Text><Text>完成入库、生产、出库或收款后，会显示在这里。</Text></View>}</View>
        {embedded && <Button className={styles.stockNotice} onClick={() => changePanel('stock')} data-testid='workbench-stock-notice'>
          <View><Text className={styles.noticeTitle}>{lowStock.length ? `库存提醒 · ${lowStock.length} 项` : '库存状态'}</Text><Text className={styles.noticeDetail}>{lowStock.length ? lowStock.map(product => `${product.name} ${product.stock}${product.unit}`).join(' · ') : '纸板与纸箱库存均可从这里查看'}</Text></View>
          <View className={styles.noticeAction}>查看库存<Icon name='chevron' color='#a6dcb8' strokeWidth={1.5} style={{ width: 16, height: 16 }} /></View>
        </Button>}
      </View>}
      {panel === 'inbound' && <View><Text className={styles.sectionTitle}>这次入库的是什么？</Text><View className={styles.choices}>{[
        { title: '纸板入库', note: '收原材料 · 带入纸板尺寸和成箱规格', path: '/pages/board-receive/index' },
        { title: '纸箱入库', note: '收外购成品 · 选择纸箱规格', path: '/pages/inbound/index?kind=carton' }
      ].map(item => <Button key={item.title} className={styles.choice} onClick={() => open(item.path)}><Icon name='package-plus' color='#a6dcb8' strokeWidth={1.5} style={{ width: 24, height: 24 }} /><View><strong>{item.title}</strong><Text>{item.note}</Text></View><Icon name='chevron' color='#a8b6ad' style={{ width: 16, height: 16 }} /></Button>)}</View><Text className={styles.note}>生产做出的纸箱，请在“生产”里确认完工，避免重复入库。</Text><View className={styles.tools}>{action('查看已有库存', () => changePanel('stock'))}{action('供货商 / 付款', () => changePanel('supplier'))}</View></View>}
      {panel === 'stock' && <View><View className={styles.stockHeading}><Text className={styles.note}>{kind === 'board' ? '纸板库存 · ' + data.boards.reduce((sum, b) => sum + b.remainingQty, 0) + ' 张' : '纸箱库存 · ' + data.products.filter(cartonProduct).length + ' 种规格'}</Text>{action('新增入库', () => changePanel('inbound'))}</View><View className={styles.segment}>{(['board', 'carton'] as const).map(k => <Button key={k} aria-pressed={kind === k} className={kind === k ? styles.selected : styles.button} onClick={() => setKind(k)}>{k === 'board' ? '纸板' : '纸箱'}</Button>)}</View><Input className={styles.input} placeholder='搜索尺寸、货名或供货商' aria-label='搜索库存' value={query} onInput={e => setQuery(e.detail.value)} />{kind === 'board' ? data.boards.filter(b => matches(boardSpec(b) + cartonSpec(b) + b.supplier)).map(b => <View className={styles.row} key={b.id} data-testid='workbench-board'><View><strong>{boardSpec(b)} cm</strong><Text>成箱 {cartonSpec(b)} cm</Text><Text>{b.supplier} · {b.fluteType}楞 · {b.layers}层 · {b.location || '未设库位'}</Text><Text>{b.date} · {b.deliveryNo || b.id}</Text></View><View><strong>{b.remainingQty} 张</strong>{action('查看 / 同规格入库', () => open('/pages/board-detail/index?id=' + b.id))}{action('生产', () => { chooseBatch(b.id); changePanel('production'); })}</View></View>) : data.products.filter(cartonProduct).filter(p => matches(p.name + p.specification)).map(p => <View key={p.id} className={styles.row} data-testid='workbench-carton'><View><strong>{p.name}</strong><Text>{p.specification || '规格未填写'}</Text></View><View><strong>{p.stock} {p.unit}</strong>{action('盘点 / 调整库存', () => openStocktake(p), true)}{action('入库', () => { Taro.setStorageSync('sg_transit', { product_id: p.id }); open('/pages/inbound/index?kind=carton'); })}</View></View>)}{!(kind === 'board' ? data.boards : data.products.filter(cartonProduct)).length && <Text className={styles.empty}>还没有{kind === 'board' ? '纸板' : '纸箱'}库存记录</Text>}</View>}
      {panel === 'production' && <View className={styles.form}><Text className={styles.label}>领用哪批纸板</Text><Picker range={['请选择纸板批次', ...data.boards.map(b => boardSpec(b) + ' cm · ' + b.supplier + ' · 余 ' + b.remainingQty + ' 张')]} value={data.boards.findIndex(b => b.id === batchId) + 1} onChange={e => chooseBatch(data.boards[Number(e.detail.value) - 1]?.id || '')}><View className={styles.input}>{batch ? boardSpec(batch) + ' cm · ' + batch.supplier : '选择纸板批次 ›'}</View></Picker>{batch && <View className={styles.spec} data-testid='production-spec'><strong>纸板 {boardSpec(batch)} cm</strong><Text>成箱 {cartonSpec(batch)} cm · {batch.layers}层 {batch.fluteType}楞</Text><Text>当前可领用 {batch.remainingQty} 张</Text></View>}<Text className={styles.label}>入库纸箱商品</Text><Picker range={['新建纸箱（规格自动带入）', ...data.products.filter(cartonProduct).map(p => p.name + ' · ' + p.specification)]} value={data.products.filter(cartonProduct).findIndex(p => p.id === productId) + 1} onChange={e => setProductId(data.products.filter(cartonProduct)[Number(e.detail.value) - 1]?.id || null)}><View className={styles.input}>{data.products.find(p => p.id === productId)?.name || '新建纸箱（规格自动带入）'} ›</View></Picker>{!productId && <Input aria-label='纸箱名称' className={styles.input} placeholder='纸箱名称' value={name} onInput={e => setName(e.detail.value)} />}<View className={styles.twoFields}><View><Text className={styles.label}>领用纸板（张）</Text><Input aria-label='领用纸板数' className={styles.input} type='number' value={consumed} onInput={e => setConsumed(e.detail.value)} /></View><View><Text className={styles.label}>合格纸箱（个 / 只 / 件）</Text><Input aria-label='合格纸箱数' className={styles.input} type='number' value={quantity} onInput={e => setQuantity(e.detail.value)} /></View></View><Input aria-label='生产备注' className={styles.input} placeholder='备注（选填）' value={remark} onInput={e => setRemark(e.detail.value)} /><Text className={styles.note}>按实际用量填写，不默认一张纸板等于一个纸箱。</Text>{error && <View role='alert' className={styles.error}>{error}</View>}{action(busy ? '保存中…' : '确认完工 · 扣纸板并入纸箱', () => void submitProduction(), true)}</View>}
      {(panel === 'supplier' || panel === 'customer') && <View>
        <View className={styles.segment}>{action('客户账单', () => changePanel('customer'), panel === 'customer')}{action('供货商账单', () => changePanel('supplier'), panel === 'supplier')}</View>
        <View className={styles.balanceSummary}><Text>{panel === 'supplier' ? '待付款合计' : '待收款合计'}</Text><strong>{formatMoney((panel === 'supplier' ? data.suppliers : data.customers).reduce((sum, p) => sum + Number(panel === 'supplier' ? p.payable || 0 : p.debt || 0), 0))}</strong></View>
        <View className={styles.monthSummary} data-testid='party-month-summary'>
          <View><Text>{monthSuffix}业务额</Text><strong>{formatMoney((panel === 'supplier' ? data.suppliers : data.customers).reduce((sum, p) => sum + Number((panel === 'supplier' ? month.supplier : month.customer).get(p.id)?.monthSales || 0), 0))}</strong></View>
          <View><Text>{monthSuffix}已{panel === 'supplier' ? '付' : '收'}</Text><strong>{formatMoney((panel === 'supplier' ? data.suppliers : data.customers).reduce((sum, p) => sum + Number((panel === 'supplier' ? month.supplier : month.customer).get(p.id)?.monthSettled || 0), 0))}</strong></View>
        </View>
        {(panel === 'supplier' ? data.suppliers : data.customers).map(p => {
          const summary = (panel === 'supplier' ? month.supplier : month.customer).get(p.id);
          const current = Number(panel === 'supplier' ? p.payable || 0 : p.debt || 0);
          return <View key={p.id} className={styles.row}><View><strong>{p.name}</strong><Text>{panel === 'supplier' ? '待付款' : '待收款'} {formatMoney(current)}</Text><Text className={styles.monthLine}>{monthSuffix}业务 {formatMoney(summary?.monthSales || 0)} · 已{panel === 'supplier' ? '付' : '收'} {formatMoney(summary?.monthSettled || 0)}</Text></View><View>{action(panel === 'supplier' ? '付款' : '收款', () => { setSettling({ party: p, supplier: panel === 'supplier' }); setAmount(''); setError(''); })}{action('账单 / 票据', () => ledgerLink(panel === 'supplier', p.id))}{action('编辑资料', () => setEditor({ id: p.id, supplier: panel === 'supplier' }))}</View></View>;
        })}
        {!(panel === 'supplier' ? data.suppliers : data.customers).length && <Text className={styles.empty}>还没有{panel === 'supplier' ? '供货商' : '客户'}，可先添加资料。</Text>}
        <View className={styles.tools}>{action('新增' + (panel === 'supplier' ? '供货商' : '客户'), () => setEditor({ supplier: panel === 'supplier' }), true)}{action('上传送货单照片', () => changePanel('photos'))}{action('查看全部账单', () => ledgerLink(panel === 'supplier'))}</View>
      </View>}
      {panel === 'records' && <View><View className={styles.segment}><Button aria-pressed={recordView === 'activity'} className={recordView === 'activity' ? styles.selected : styles.button} onClick={() => setRecordView('activity')}>出入库 / 生产</Button><Button aria-pressed={recordView === 'orders'} className={recordView === 'orders' ? styles.selected : styles.button} onClick={() => setRecordView('orders')}>规格与订单</Button></View>
        {recordView === 'activity' && <View><View className={styles.tools}>{action('打印存根', () => open('/pages/print-center/index'))}{action('收款 / 付款记录', () => open('/pages/ledger/index'))}</View>{data.production.map(p => <View className={styles.record} key={p.id}><strong>生产完工 · {p.product_name}</strong><Text>纸板 {p.specification_snapshot.board.join(' × ')} cm → 纸箱 {p.specification_snapshot.carton.join(' × ')} cm</Text><Text>领用 {p.consumed_quantity} 张 · 完工 {p.quantity} {p.unit}</Text><Text>{formatTime(p.created_at)} · {p.operator}</Text><Text>{p.id}</Text></View>)}{data.boards.map(b => <View className={styles.record} key={b.id}><strong>纸板入库 · {boardSpec(b)} cm</strong><Text>对应纸箱 {cartonSpec(b)} cm · 实收 {b.receivedQty} 张</Text><Text>送货日期 {b.date} · {b.supplier}</Text><Text>登记时间 {formatTime(b.createdAt)}</Text>{action('批次存根', () => open('/pages/board-detail/index?id=' + b.id))}</View>)}{data.transactions.filter(t => !t.production_id && !t.voided_at).slice(0, 30).map(t => <View className={styles.record} key={t.id}><strong>{t.type === 'in' ? '入库' : t.type === 'out' ? '出库' : '盘点'} · {t.product_name}</strong><Text>{t.specification} · {t.quantity} {t.unit}</Text><Text>{formatTime(t.created_at)}</Text></View>)}{action('全部出入库记录', () => open('/pages/records/index'))}</View>}
        {recordView === 'orders' && <View><Input className={styles.input} aria-label='搜索订单' placeholder='搜索客户、规格或订单号' value={query} onInput={e => setQuery(e.detail.value)} /><View className={styles.segment}>{(['全部', '待生产', '生产中', '已发货', '已完成', '已取消'] as const).map(value => <Button key={value} aria-pressed={orderStatus === value} className={orderStatus === value ? styles.selected : styles.button} onClick={() => setOrderStatus(value)}>{value}</Button>)}</View>{visibleOrders.filter(order => matches([order.order_no, order.customer_name, order.specification, order.material, order.status, order.remark].join(' '))).map(order => <View key={order.id} className={styles.record} data-testid='workbench-order'><strong>{order.customer_name} · {order.specification || '未填规格'}</strong><Text>{order.quantity} {order.unit} × {formatMoney(order.unit_price)} · 合计 {formatMoney(order.amount)}</Text><Text>交期 {order.delivery_date || '未设置'} · {order.status}</Text><Text>{order.order_no} · {formatTime(order.created_at)}</Text><View className={styles.tools}>{action('打印存根', () => open('/pages/print-center/index'))}{action('核对出库', () => { Taro.setStorageSync('sg_outbound_order', order.id); const host = typeof document !== 'undefined' ? document.querySelector<HTMLElement>('taro-tabbar') : null; if (host && getComputedStyle(host).display !== 'none') void Taro.switchTab({ url: '/pages/outbound/index' }); else open('/pages/outbound/index'); }, true)}</View></View>)}{!visibleOrders.filter(order => matches([order.order_no, order.customer_name, order.specification, order.material, order.status, order.remark].join(' '))).length && <Text className={styles.empty}>没有找到匹配订单</Text>}</View>}
      </View>}
      {panel === 'photos' && <View><Text className={styles.note}>原件照片按业务账单保存；选择一笔账单，可上传送货单、签收单或付款凭证。</Text>{data.ledger.filter(l => !l.voided_at).map(l => <Button className={styles.photoRow} key={l.id} onClick={() => open('/pages/ledger/index?entry=' + l.id)}><strong>{l.party_name || l.remark}</strong><Text>{formatTime(l.created_at)} · {formatMoney(l.amount)}</Text><Text>{l.attachments?.length ? l.attachments.length + ' 张原件照片' : '上传原件照片 ›'}</Text></Button>)}{!data.ledger.length && <Text className={styles.empty}>入库或出库保存后，账单会出现在这里。</Text>}</View>}
    </View>}
    </View>
    {!embedded && <View className={styles.nav}>{([{ key: 'home', text: '总台', icon: 'home' }, { key: 'stock', text: '库存', icon: 'boxes' }, { key: 'records', text: '记录', icon: 'notebook' }, { key: 'photos', text: '票据', icon: 'photos' }] as const).map(n => <Button key={n.key} aria-pressed={panel === n.key} onClick={() => changePanel(n.key)}><Icon name={n.icon} color={panel === n.key ? '#a6dcb8' : '#a8b6ad'} strokeWidth={1.5} style={{ width: 21, height: 21 }} /><Text>{n.text}</Text></Button>)}</View>}
    <View className={styles.footer} role='status'><Text>{status}</Text><Text>{editor ? '资料编辑中' : settling ? '金额待确认' : '照片上传需确认保存'}</Text></View>
    {settling && <View className={styles.overlay}><View className={styles.dialog} role='dialog' aria-label={settling.supplier ? '付款' : '收款'}><strong>{settling.supplier ? '付款给' : '收到'} {settling.party.name}</strong><Text>当前余额 {formatMoney(Number(settling.supplier ? settling.party.payable || 0 : settling.party.debt || 0))}</Text><Input aria-label='本次金额' className={styles.input} type='digit' placeholder='本次金额' value={amount} onInput={e => setAmount(e.detail.value)} />{error && <View role='alert'>{error}</View>}<View className={styles.tools}>{action('取消', () => setSettling(null))}{action('确认保存', () => void submitSettlement(), true)}</View></View></View>}
    {stocktake && <View className={styles.overlay}><View className={styles.dialog} role='dialog' aria-label='库存盘点'><strong>{stocktake.product.name}</strong><View className={styles.stocktakeSummary}><Text>{stocktake.product.specification || '规格未填写'}</Text><Text>当前 {stocktake.product.stock} {stocktake.product.unit}</Text></View><Text className={styles.label}>新库存</Text><Input aria-label='实盘库存' className={styles.input} type='digit' placeholder='填写实际盘点数量' value={stocktakeValue} onInput={e => setStocktakeValue(e.detail.value)} /><Text className={styles.label}>盘点日期</Text><Picker mode='date' end={currentDate()} value={stocktakeDate} onChange={e => setStocktakeDate(e.detail.value)}><View aria-label='盘点日期' className={styles.input}>{stocktakeDate || '请选择日期'}</View></Picker><Input aria-label='盘点备注' className={styles.input} placeholder='备注（选填，如盘亏原因）' value={stocktakeRemark} onInput={e => setStocktakeRemark(e.detail.value)} />{stocktakeValue.trim() && /^\d+(?:\.\d{1,6})?$/.test(stocktakeValue.trim()) && <Text className={styles.note}>调整后库存 {stocktakeValue.trim()} {stocktake.product.unit}，盘点流水会同步保存。</Text>}{error && <View role='alert' className={styles.error}>{error}</View>}<View className={styles.tools}>{action('取消', () => { setStocktake(null); setError(''); })}{action(busy ? '保存中…' : '确认盘点', () => void submitStocktake(), true)}</View></View></View>}
    {editor && <CustomerEditor id={editor.id} supplier={editor.supplier} onClose={() => setEditor(null)} onSaved={async () => { setEditor(null); await reload(); }} />}
  </View></View>;
}
