import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { View, Text, Button, Input, Picker } from '@tarojs/components';
import Taro, { useDidShow, useRouter } from '@tarojs/taro';
import Icon, { IconName } from '@/components/Icon';
import CustomerEditor from '@/components/CustomerEditor';
import { addStocktake, getStats } from '@/services/api';
import { boardSpec, cartonSpec, today as currentDate } from '@/services/boards';
import { completeProduction } from '@/services/business-workflow';
import { useRemoteData } from '@/hooks/useRemoteData';
import { useSharedRefresh } from '@/services/shared-refresh';
import { invalidateProducts } from '@/services/product-store';
import { getCopy } from '@/services/copy';
import { formatMoney, formatTime } from '@/utils/format';
import type { CustomerOrder, Product, Stats } from '@/types';
import FinanceCenter from '@/components/FinanceCenter';
import type { FinanceView } from '@/components/FinanceCenter';
import CustomerCenter from '@/components/CustomerCenter';
import SupplierCenter from '@/components/SupplierCenter';
import { emptyWorkbenchData as empty, useWorkbenchData, WorkbenchSource } from '@/pages/home/useWorkbenchData';
import { attentionOrders, dashboardTasks, isStockWarning, HomeTask, OrderAttention } from '@/pages/home/dashboard-model';
import styles from '@/components/Workspace/workbench.module.scss';
import { dailyRecords, DailyRecord } from '@/components/Workspace/daily-records';
import { openBusinessPage } from '@/services/business-navigation';
import StockList from '@/components/Workspace/stock-list';

type Panel = 'home' | 'inbound' | 'stock' | 'records' | 'photos' | 'production' | 'finance' | 'customers' | 'suppliers';
type WorkbenchProps = {
  embedded?: boolean;
  initial?: Panel;
};
const open = (url: string) => void openBusinessPage(url);
const cartonProduct = (p: Product) => p.category !== '纸板' && (p.category === '纸箱' || /\d\s*[×xX*]\s*\d.*[×xX*]/.test(p.specification || ''));
const routeFinanceView = (params: Record<string, string | undefined>): FinanceView =>
  params.view === 'customer' || params.view === 'supplier' || params.view === 'ledger'
    ? params.view
    : params.party_type === 'supplier' ? 'supplier'
      : params.party_type === 'customer' ? 'customer' : 'overview';
const normalizedRoutePath = (route: string) => route.replace(/^\/+/, '').split('?')[0];
const initialPanel = (section?: string, detail?: string, route = ''): Panel => {
  const routePath = normalizedRoutePath(route);
  if (section === 'production' || section === 'inbound' || section === 'photos') return section;
  return section === 'customers' ? 'customers'
    : section === 'suppliers' ? 'suppliers'
      : section === 'finance' ? 'finance'
      : routePath === 'pages/customers/index' || routePath === 'customers/index' ? 'customers'
        : section === 'stock' || routePath === 'pages/inventory/index' || routePath === 'inventory/index' ? 'stock'
          : section === 'records' || detail === '1' ? 'records'
              : routePath === 'pages/management/index' ? 'stock' : 'home';
};

export default function Workbench({ embedded = false, initial }: WorkbenchProps) {
  const { params, path } = useRouter();
  const remote = useWorkbenchData(), { data, reload } = remote;
  const [panel, setPanel] = useState<Panel>(() => initial || initialPanel(params.section, params.detail, path));
  const [financeView, setFinanceView] = useState<FinanceView>(() => routeFinanceView(params));
  const [financePartyId, setFinancePartyId] = useState<number | undefined>(() => params.party_id ? Number(params.party_id) : undefined);
  const [financeEntryId, setFinanceEntryId] = useState<number | undefined>(() => params.entry ? Number(params.entry) : undefined);
  const summaryRemote = useRemoteData<Stats | null>(getStats, null), stats = summaryRemote.data;
  const reloadSummary = summaryRemote.reload;
  const [kind, setKind] = useState<'all' | 'board' | 'carton'>('all');
  const [business, setBusiness] = useState<'sales' | 'stock'>('sales');
  const [query, setQuery] = useState('');
  const [now, setNow] = useState(new Date());
  const [lastSyncedAt, setLastSyncedAt] = useState<number | null>(null);
  const hasSnapshot = data !== empty;
  const [batchId, setBatchId] = useState(params.batch_id || '');
  const [productId, setProductId] = useState<number | null>(null);
  const [name, setName] = useState('');
  const [consumed, setConsumed] = useState('');
  const [quantity, setQuantity] = useState('');
  const [remark, setRemark] = useState('');
  const [busy, setBusy] = useState(false), [error, setError] = useState('');
  const [editor, setEditor] = useState<{ id?: number; supplier: boolean; initialName?: string; lockName?: boolean } | null>(null);
  const [recordView, setRecordView] = useState<'activity' | 'orders'>(() => params.detail === '1' ? 'orders' : 'activity');
  const [orderStatus, setOrderStatus] = useState<'全部' | CustomerOrder['status']>('全部');
  const [orderAttention, setOrderAttention] = useState<OrderAttention | null>(null);
  const [stockWarningsOnly, setStockWarningsOnly] = useState(false);
  const [moreOpen, setMoreOpen] = useState(false);
  const [stocktake, setStocktake] = useState<{ product: Product } | null>(null);
  const [stocktakeValue, setStocktakeValue] = useState('');
  const [stocktakeDate, setStocktakeDate] = useState('');
  const [stocktakeRemark, setStocktakeRemark] = useState('');
  const locked = useRef(false), shown = useRef(false);
  const customerRoute = ['pages/customers/index', 'customers/index'].includes(normalizedRoutePath(path));
  const supplierRoute = params.section === 'suppliers';
  const refresh = useCallback(() => {
    void reload();
    void reloadSummary();
  }, [reload, reloadSummary]);
  useSharedRefresh(refresh);
  useDidShow(() => {
    if (shown.current) refresh();
    shown.current = true;
  });
  useEffect(() => { if (data !== empty) setLastSyncedAt(Date.now()); }, [data]);
  useEffect(() => { const timer = setInterval(() => setNow(new Date()), 1000); return () => clearInterval(timer); }, []);

  const batch = data.boards.find(b => b.id === batchId);
  const matches = useCallback((value: string) => value.toLowerCase().replace(/[ ×xX*]/g, '').includes(query.toLowerCase().replace(/[ ×xX*]/g, '')), [query]);
  const cartonProducts = useMemo(() => data.products.filter(cartonProduct), [data.products]);
  const visibleBoards = useMemo(() => data.boards.filter(board => matches([boardSpec(board), cartonSpec(board), board.supplier, board.customerName, board.location, board.material, board.printPlate, board.printColor].join(' '))), [data.boards, matches]);
  const visibleCartons = useMemo(() => (stockWarningsOnly ? data.products.filter(isStockWarning) : cartonProducts).filter(product => matches([product.name, product.specification, product.customer_name, ...data.transactions.filter(row => row.product_id === product.id && !row.voided_at).map(row => [row.customer_name, row.supplier_name].join(' '))].join(' '))), [data.products, data.transactions, stockWarningsOnly, cartonProducts, matches]);
  const stockCount = kind === 'board' ? data.boards.length : stockWarningsOnly ? data.products.filter(isStockWarning).length : kind === 'all' ? data.boards.length + cartonProducts.length : cartonProducts.length;
  const visibleStockCount = kind === 'board' ? visibleBoards.length : kind === 'all' ? visibleBoards.length + visibleCartons.length : visibleCartons.length;
  const returnToTop = useCallback(() => {
    if (typeof document === 'undefined') return;
    requestAnimationFrame(() => {
      const page = Array.from(document.querySelectorAll<HTMLElement>('.taro_page')).reverse()
        .find(element => getComputedStyle(element).display !== 'none');
      if (page) page.scrollTop = 0;
      window.scrollTo(0, 0);
    });
  }, []);
  const changePanel = (next: Panel) => { setPanel(next); setQuery(''); setError(''); setStockWarningsOnly(false); setOrderAttention(null); if (next !== 'records') setRecordView('activity'); returnToTop(); };
  const openFinance = (view: FinanceView, entry?: number) => { setFinancePartyId(undefined); setFinanceView(view); setFinanceEntryId(entry); changePanel('finance'); };
  const leaveCustomerCenter = () => {
    if (!customerRoute && !supplierRoute) { changePanel('home'); return; }
    if (Taro.getCurrentPages().length > 1) void Taro.navigateBack({ delta: 1 });
    else void Taro.switchTab({ url: '/pages/home/index' });
  };
  const openCustomerBills = (id: number) => {
    if (!customerRoute) {
      setFinancePartyId(id);
      setFinanceEntryId(undefined);
      setFinanceView('customer');
      changePanel('finance');
      return;
    }
    void Taro.redirectTo({ url: `/pages/management/index?section=finance&view=customer&party_type=customer&party_id=${encodeURIComponent(String(id))}` });
  };
  const activeLedger = useMemo(() => data.ledger.filter(entry => !entry.voided_at), [data.ledger]);
  const action = (label: string, fn: () => void, primary = false) => <Button className={primary ? styles.primary : styles.button} disabled={busy || undefined} onClick={fn}>{label}</Button>;
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
  const title = { home: '业务总台', inbound: '选择入库方式', stock: '库存管理', records: '业务记录', photos: '票据原件', production: '生产入库', finance: '收付款', customers: '客户管理', suppliers: '供货商管理' }[panel];
  const appName = getCopy('appName');
  const brandCharacter = Array.from(appName.trim())[0] || '曙';
  const today = useMemo(() => dailyRecords(data).slice(0, 3), [data]);
  const tasks = useMemo(() => dashboardTasks(data, now), [data, now]);
  const visibleOrders = useMemo(() => {
    const orders = orderAttention ? attentionOrders(data.orders, orderAttention, now) : data.orders;
    return orderStatus === '全部' ? orders : orders.filter(order => order.status === orderStatus);
  }, [data.orders, orderStatus, orderAttention, now]);
  const openOrders = (attention?: OrderAttention) => { changePanel('records'); setRecordView('orders'); setOrderStatus(attention ? '全部' : '待发货'); setOrderAttention(attention || null); };
  const openStockWarnings = () => { changePanel('stock'); setKind('carton'); setStockWarningsOnly(true); };
  const openTask = (task: HomeTask) => {
    if (task.id === 'overdue' || task.id === 'upcoming') openOrders(task.id);
    else if (task.id === 'stock') openStockWarnings();
    else openFinance(task.id === 'receivable' ? 'customer' : 'supplier');
  };
  const sourceState = (keys: WorkbenchSource[]) => ({
    loading: keys.some(key => remote.sources[key].loading),
    error: keys.map(key => remote.sources[key].error).filter(Boolean).join('；')
  });
  const taskState = sourceState(['orders', 'products', 'customers', 'suppliers']);
  const activityState = sourceState(['boards', 'production', 'transactions', 'ledger']);
  const pendingShipments = remote.sources.orders.loading && !data.orders.length || remote.sources.orders.error ? '--' : data.orders.filter(order => order.status === '待发货').length;
  const partialError = (message: string, retry: () => void) => <View role='alert' className={styles.sectionError}><Text>{message}</Text><Button className={styles.textAction} onClick={retry}>重试</Button></View>;
  const openRecord = (row: DailyRecord) => {
    if ('board' in row.target) open('/pages/management/index?section=paperboard-batch&id=' + encodeURIComponent(row.target.board));
    else if ('ledger' in row.target) openFinance('ledger', row.target.ledger)
    else changePanel('records');
  };
  const chooseBatch = (id: string) => { setBatchId(id); setProductId(null); setName(''); setError(''); };
  const salesSteps = [
    { title: '客户下单', fn: () => open('/pages/management/index?section=orders&create=1') },
    { title: '检查库存', fn: () => changePanel('stock') },
    { title: '客户出库', fn: () => open('/pages/management/index?section=shipment') },
    { title: '对账收款', fn: () => openFinance('customer') }
  ];
  const stockSteps = [
    { title: '采购纸板', fn: () => open('/pages/management/index?section=suppliers') },
    { title: '纸板入库', fn: () => open('/pages/management/index?section=paperboard-receipt') },
    { title: '领纸板生产', fn: () => changePanel('production') },
    { title: '成品入库', fn: () => changePanel('production') }
  ];
  const nextOrders = data.orders.filter(order => !['已完成', '已取消', '已发货'].includes(order.status)).slice(0, 3);
  return <View className={styles.page} data-ui-version='web-workbench-v2' data-layout='demo-layout-v1' data-panel={panel} data-testid='simple-workbench' data-tab-route={embedded ? undefined : panel === 'stock' ? '/pages/inventory/index' : '/pages/home/index'}><View className={styles.surface}>
    <View className={styles.masthead}>
      <View className={styles.header}><View className={styles.heading}>
        {panel === 'home' ? <View className={styles.brand} aria-label={`${appName}标识`} data-testid='workbench-brand'><Text className={styles.brandCharacter}>{brandCharacter}</Text></View> : <Button aria-label='返回总台' className={styles.back} onClick={panel === 'customers' || panel === 'suppliers' ? leaveCustomerCenter : () => changePanel('home')}>‹</Button>}
        <View className={styles.headingText}><Text className={styles.brandName}>{appName}</Text><Text className={styles.title}>{title}</Text></View>
      </View><Button className={styles.refresh} aria-label='刷新服务器数据' disabled={remote.loading} onClick={refresh}>↻</Button></View>
      <View className={styles.status}><Text>{now.getMonth() + 1}月{now.getDate()}日 · 周{'日一二三四五六'[now.getDay()]}</Text><Text data-testid='workbench-sync-status' className={remote.loadError ? styles.syncError : styles.synced}>{remote.loading ? hasSnapshot ? '同步中 · 当前数据仍可查看' : '同步中' : remote.loadError ? '同步未完成 · 当前显示上次成功数据' : lastSyncedAt ? '● 已同步' : ''}</Text></View>
    </View>
    {['stock', 'finance', 'suppliers'].includes(panel) && <View className={styles.managementNav} role='tablist' aria-label='业务管理'>
      <Button aria-pressed={false} onClick={() => changePanel('home')}>⌂ 总台</Button>
      {([['stock', '库存'], ['finance', '收付款'], ['suppliers', '供货商']] as const).map(([value, label]) => <Button key={value} aria-pressed={panel === value} className={panel === value ? styles.managementActive : ''} onClick={() => changePanel(value)}>{label}</Button>)}
    </View>}
    <View className={styles.content} data-testid='workbench-content'>
    {remote.loadError && panel !== 'home' && <View role='alert' className={styles.error}>{remote.loadError}{action('重新读取', () => void reload())}</View>}
    {!hasSnapshot && remote.loading && panel !== 'home' && panel !== 'finance' && <View className={styles.empty} role='status' data-testid='workbench-initial-loading'>正在读取业务数据，请稍候…</View>}
    {/* Retain the last successful snapshot during refreshes and failures.
        This also keeps finance details and unsaved photo drafts mounted. */}
    {(hasSnapshot || panel === 'home' || panel === 'finance' || panel === 'customers' || panel === 'suppliers') && <View>
      {panel === 'home' && <View className={styles.home}>
        <View data-testid='workbench-tasks'>
          {taskState.error && partialError(taskState.error, () => void reload())}
          {tasks.length > 0 && <View className={styles.attention}><Text>!</Text><strong>{tasks.length} 项业务待处理</strong><Button onClick={() => openTask(tasks[0])}>去处理 ›</Button></View>}
        </View>
        <View className={styles.businessTabs} role='group' aria-label='业务类型'>
          {(['sales', 'stock'] as const).map(value => <Button key={value} aria-pressed={business === value} className={business === value ? styles.businessActive : styles.businessTab} onClick={() => setBusiness(value)}>{value === 'sales' ? '销售业务' : '备货业务'}</Button>)}
        </View>
        <View className={styles.businessFlow} data-testid='workbench-business-flow' role='tabpanel' aria-label={business === 'sales' ? '销售业务' : '备货业务'}>
          <View className={styles.flowHeading}><View><Text className={styles.eyebrow}>{business === 'sales' ? 'SALES WORKFLOW' : 'STOCK WORKFLOW'}</Text><Text className={styles.sectionTitle}>{business === 'sales' ? '从客户开单开始' : '先备货，随时接单'}</Text></View><Text className={styles.sectionHint}>{business === 'sales' ? '资料只填一次' : '无需客户订单'}</Text></View>
          <View className={styles.flowSteps}>{(business === 'sales' ? salesSteps : stockSteps).map((step, index) => <Button key={step.title} className={styles.flowStep} onClick={step.fn}><Text className={styles.flowNumber}>{index + 1}</Text><Text>{step.title}</Text></Button>)}</View>
          <View className={styles.flowNote}>{business === 'sales' ? '库存够直接发货 · 缺货安排生产，完工后继续原单' : '生产入库一次办理：扣纸板 ＋ 增成品'}</View>
          <View className={styles.flowActions}>{business === 'sales' ? action('＋ 客户开单', salesSteps[0].fn, true) : <>{action('＋ 纸板入库', stockSteps[1].fn)}{action('＋ 生产入库', stockSteps[2].fn, true)}{action('＋ 纸箱入库', () => open('/pages/management/index?section=receipt&kind=carton'))}</>}</View>
        </View>
        <View className={styles.recentHeading}><Text className={styles.sectionTitle}>{business === 'sales' ? '接下来要做' : '备货提醒'}</Text><Button className={styles.textAction} onClick={() => business === 'sales' ? open('/pages/management/index?section=orders') : openStockWarnings()}>{business === 'sales' ? '全部订单' : '库存预警'}<Icon name='chevron' color='#2469ee' style={{ width: 14, height: 14 }} /></Button></View>
        {business === 'sales' ? <View data-testid='workbench-next-orders'>{nextOrders.map(order => <View className={styles.nextOrder} key={order.id}>
          <View className={styles.orderHeading}><View className={styles.avatar}>{Array.from(order.customer_name || '客')[0]}</View><View className={styles.orderIdentity}><strong>{order.customer_name}</strong><Text>{order.order_no}</Text></View><Text className={styles.orderBadge}>{order.status}</Text></View>
          <View className={styles.orderGoods}><Text>{order.specification}</Text><Text>{order.quantity} {order.unit}</Text></View>
          <View className={styles.orderNext}><Text>{order.delivery_date || '未设交期'} · {formatMoney(order.amount)}</Text>{action(order.status === '待发货' ? '核对出库' : '查看订单', () => { if (order.status === '待发货') { Taro.setStorageSync('sg_outbound_order', order.id); open('/pages/management/index?section=shipment'); } else open('/pages/management/index?section=orders'); })}</View>
        </View>)}{!nextOrders.length && !remote.sources.orders.loading && <View className={styles.sectionHint}>暂无待处理订单</View>}</View> : <View>{data.products.filter(isStockWarning).slice(0, 3).map(product => <View className={styles.nextOrder} key={product.id}><View className={styles.orderHeading}><strong>{product.name}</strong><Text className={styles.orderBadge}>待补货</Text></View><Text className={styles.orderSpec}>{product.specification} · 现存 {product.stock} {product.unit}</Text><View className={styles.orderNext}><Text>安全库存 {product.safety_stock} {product.unit}</Text>{action('安排生产', () => { setProductId(product.id); changePanel('production'); })}</View></View>)}{!data.products.some(isStockWarning) && <View className={styles.sectionHint}>当前暂无库存预警</View>}</View>}
        <View className={styles.homeHeading}><Text className={styles.sectionTitle}>经营一眼看清</Text><Text className={styles.sectionHint}>与业务同步更新</Text></View>
        <View className={styles.summary} data-testid='workbench-summary'>
          <Button className={styles.summaryItem} onClick={() => openOrders()}><Text>待发货</Text><strong>{pendingShipments}</strong></Button>
          <Button className={styles.summaryItem} onClick={openStockWarnings}><Text>库存预警</Text><strong>{stats ? stats.lowStock : '--'}</strong></Button>
          <Button className={styles.summaryItem} onClick={() => openFinance('customer')}><Text>待收款</Text><strong>{stats?.totalReceivable == null ? '--' : formatMoney(stats.totalReceivable)}</strong></Button>
          <Button className={styles.summaryItem} onClick={() => openFinance('supplier')}><Text>待付款</Text><strong>{stats?.totalPayable == null ? '--' : formatMoney(stats.totalPayable)}</strong></Button>
        </View>
        {summaryRemote.loadError && partialError(`经营摘要加载失败：${summaryRemote.loadError}`, () => void summaryRemote.reload())}
        {remote.sources.orders.error && partialError(remote.sources.orders.error, () => void reload())}
        <View className={styles.shortcuts} data-testid='workbench-actions'>{([
          { title: '收付款', icon: 'wallet', fn: () => openFinance('overview') },
          { title: '客户', icon: 'mine', fn: () => open('/pages/customers/index') },
          { title: '供货商', icon: 'factory', fn: () => open('/pages/management/index?section=suppliers') },
          { title: '更多', icon: 'list', fn: () => setMoreOpen(true) }
        ] as { title: string; icon: IconName; fn: () => void }[]).map(e => <Button key={e.title} data-testid={e.title === '客户' ? 'workbench-customer-management' : undefined} className={styles.shortcut} onClick={e.fn}>
          <View><Icon name={e.icon} color='#6384b6' strokeWidth={1.5} style={{ width: 21, height: 21 }} /></View><Text>{e.title}</Text>
        </Button>)}</View>
        <View className={styles.recentHeading}><Text className={styles.sectionTitle}>最近动态</Text><Button className={styles.textAction} onClick={() => changePanel('records')}>全部记录<Icon name='chevron' color='#1677ff' strokeWidth={1.5} style={{ width: 16, height: 16 }} /></Button></View>
        {activityState.error && partialError(activityState.error, () => void reload())}
        {activityState.loading && <View role='status' className={styles.sectionHint}>最近动态正在同步…</View>}
        <View data-testid='workbench-today'>{today.map(row => <Button key={row.id} className={styles.activity} onClick={() => openRecord(row)}>
          <Icon name={row.icon} color='#64748b' strokeWidth={1.5} style={{ width: 21, height: 21 }} />
          <View className={styles.activityBody}><Text className={styles.activityTitle}>{row.title}</Text><Text className={styles.activityDetail}>{formatTime(row.time)} · {row.detail}</Text></View>
          <View className={styles.activityValue}><Text>{row.money ? formatMoney(row.value) : `${row.value} ${row.unit || ''}`}</Text><Text className={styles.activityStatus}>{row.status}</Text></View>
        </Button>)}{!today.length && !activityState.loading && !activityState.error && <View className={styles.emptyToday}><Icon name='notebook' color='#94a3b8' strokeWidth={1.5} style={{ width: 28, height: 28 }} /><Text>还没有业务记录</Text><Text>完成入库、生产、出库或收款后，会显示在这里。</Text></View>}</View>
      </View>}
      {panel === 'customers' && hasSnapshot && <CustomerCenter
        customers={data.customers}
        dimensionCustomers={data.customerDimensions.customers}
        inactiveCustomerNames={data.customerDimensions.inactiveCustomerNames || []}
        onEditParty={(type, id, initialName) => setEditor({ id, supplier: type !== 'customer', initialName, lockName: Boolean(initialName) })}
        onViewBills={openCustomerBills}
        onOpenOrders={id => open('/pages/management/index?section=orders&create=1' + (id ? '&customer_id=' + id : ''))}
        onSpecsSaved={() => reload()}
      />}
      {panel === 'customers' && !hasSnapshot && !remote.loading && <View className={styles.empty}>客户资料暂不可用</View>}
      {panel === 'suppliers' && <SupplierCenter
        suppliers={data.suppliers}
        onEditParty={(_type, id) => setEditor({ id, supplier: true })}
        onViewBills={id => { setFinancePartyId(id); setFinanceEntryId(undefined); setFinanceView('supplier'); changePanel('finance'); }}
        onSpecsSaved={() => reload()}
      />}
      {panel === 'inbound' && <View><Text className={styles.sectionTitle}>这次入库的是什么？</Text><View className={styles.choices}>{[
        { title: '纸板入库', note: '采购原料到货 · 增纸板库存，记供货商应付', path: '/pages/management/index?section=paperboard-receipt' },
        { title: '纸箱入库', note: '补录自产成品 · 已登记生产完工的同批货不再录', path: '/pages/management/index?section=receipt&kind=carton' }
      ].map(item => <Button key={item.title} className={styles.choice} onClick={() => open(item.path)}><Icon name='package-plus' color='#1677ff' strokeWidth={1.5} style={{ width: 24, height: 24 }} /><View><strong>{item.title}</strong><Text>{item.note}</Text></View><Icon name='chevron' color='#94a3b8' style={{ width: 16, height: 16 }} /></Button>)}</View><Text className={styles.note}>正常生产请点“生产纸箱并入库”：同时扣纸板、增纸箱，不需要先有客户订单；同批纸箱只入库一次。</Text><View className={styles.tools}>{action('生产纸箱并入库', () => changePanel('production'), true)}{action('查看已有库存', () => changePanel('stock'))}{action('供货商 / 付款', () => openFinance('supplier'))}</View></View>}
      {panel === 'stock' && <View>
        {stockWarningsOnly && <View className={styles.filterNotice}><Text>库存预警 · 全部商品</Text><Button className={styles.textAction} onClick={() => setStockWarningsOnly(false)}>清除筛选</Button></View>}
        <View className={styles.stockSummary}><View><Text>纸板原料</Text><strong>{hasSnapshot ? data.boards.reduce((sum, b) => sum + b.remainingQty, 0).toLocaleString() : '—'}<small>张</small></strong><Text>{hasSnapshot ? `${data.boards.length} 个批次` : ''}</Text></View><View><Text>纸箱成品</Text><strong>{hasSnapshot ? cartonProducts.reduce((sum, p) => sum + p.stock, 0).toLocaleString() : '—'}<small>个</small></strong><Text>{hasSnapshot ? `${cartonProducts.length} 种规格` : ''}</Text></View></View>
        <View className={styles.stockHeading}><Text className={styles.sectionHint}>原料与成品</Text>{action('入库', () => changePanel('inbound'))}</View>
        <Input className={styles.input} placeholder='搜索尺寸、货名、客户或供货商' aria-label='搜索库存' value={query} onInput={e => setQuery(e.detail.value)} />
        <View className={styles.segment}>{(['all', 'board', 'carton'] as const).map(k => <Button key={k} aria-pressed={kind === k && !stockWarningsOnly} className={kind === k && !stockWarningsOnly ? styles.selected : styles.button} onClick={() => { setKind(k); setStockWarningsOnly(false); }}>{k === 'all' ? '全部库存' : k === 'board' ? '纸板' : '纸箱'}</Button>)}<Button aria-pressed={stockWarningsOnly} className={stockWarningsOnly ? styles.selected : styles.button} onClick={openStockWarnings}>库存预警</Button></View>
        <StockList kind={kind} boards={visibleBoards} cartons={visibleCartons} transactions={data.transactions} onProduce={id => { chooseBatch(id); changePanel('production'); }} onStocktake={openStocktake} onInbound={product => { Taro.setStorageSync('sg_transit', { product_id: product.id }); open('/pages/management/index?section=receipt&kind=carton'); }} />
        {!visibleStockCount && <View className={styles.empty} data-testid='workbench-stock-empty'><Text>{stockCount ? '没有找到匹配库存' : `还没有${kind === 'board' ? '纸板' : '纸箱'}库存记录`}</Text>{stockCount > 0 && action('清空搜索', () => setQuery(''))}</View>}
      </View>}
      {panel === 'production' && <View className={styles.form}><Text className={styles.note} data-testid='production-stock-guide'>先采购纸板并入库，再在这里登记生产：扣减实际领用纸板，同时增加完工纸箱库存。无需客户或订单，后续客户下单再出库；同批纸箱不必再登记入库。</Text><Text className={styles.label}>领用哪批纸板</Text><Picker range={['请选择纸板批次', ...data.boards.map(b => boardSpec(b) + ' cm · ' + b.supplier + ' · 余 ' + b.remainingQty + ' 张')]} value={data.boards.findIndex(b => b.id === batchId) + 1} onChange={e => chooseBatch(data.boards[Number(e.detail.value) - 1]?.id || '')}><View className={styles.input}>{batch ? boardSpec(batch) + ' cm · ' + batch.supplier : '选择纸板批次 ›'}</View></Picker>{batch && <View className={styles.spec} data-testid='production-spec'><strong>纸板 {boardSpec(batch)} cm</strong><Text>成箱 {cartonSpec(batch)} cm · {batch.layers}层 {batch.fluteType}楞</Text><Text>当前可领用 {batch.remainingQty} 张</Text></View>}<Text className={styles.label}>入库纸箱商品</Text><Picker range={['新建纸箱（规格自动带入）', ...data.products.filter(cartonProduct).map(p => p.name + ' · ' + p.specification)]} value={data.products.filter(cartonProduct).findIndex(p => p.id === productId) + 1} onChange={e => setProductId(data.products.filter(cartonProduct)[Number(e.detail.value) - 1]?.id || null)}><View className={styles.input}>{data.products.find(p => p.id === productId)?.name || '新建纸箱（规格自动带入）'} ›</View></Picker>{!productId && <Input aria-label='纸箱名称' className={styles.input} placeholder='纸箱名称' value={name} onInput={e => setName(e.detail.value)} />}<View className={styles.twoFields}><View><Text className={styles.label}>领用纸板（张）</Text><Input aria-label='领用纸板数' className={styles.input} type='number' value={consumed} onInput={e => setConsumed(e.detail.value)} /></View><View><Text className={styles.label}>合格纸箱（个 / 只 / 件）</Text><Input aria-label='合格纸箱数' className={styles.input} type='number' value={quantity} onInput={e => setQuantity(e.detail.value)} /></View></View><Input aria-label='生产备注' className={styles.input} placeholder='备注（选填）' value={remark} onInput={e => setRemark(e.detail.value)} /><Text className={styles.note}>按实际用量填写，不默认一张纸板等于一个纸箱。</Text>{error && <View role='alert' className={styles.error}>{error}</View>}{action(busy ? '保存中…' : '确认完工 · 扣纸板并入纸箱', () => void submitProduction(), true)}</View>}
      {panel === 'finance' && <FinanceCenter
        initialView={financeView}
        partyType={params.party_type === 'customer' || params.party_type === 'supplier' ? params.party_type : undefined}
        partyId={financePartyId}
        entryId={financeEntryId}
        ledger={data.ledger}
        customers={data.customers}
        suppliers={data.suppliers}
        dimensionCustomers={data.customerDimensions.customers}
        inactiveCustomerNames={data.customerDimensions.inactiveCustomerNames}
        deliveryNotes={data.deliveryNotes}
        loading={remote.loading}
        loadError={remote.loadError}
        onReload={reload}
        onViewChange={setFinanceView}
        onEditParty={(type, id) => {
          if (id == null) { open(type === 'supplier' ? '/pages/management/index?section=suppliers' : '/pages/customers/index'); return; }
          setEditor({ id, supplier: type === 'supplier' });
        }}
      />}
      {panel === 'records' && <View>{orderAttention && <View className={styles.filterNotice}><Text>{orderAttention === 'overdue' ? '逾期订单' : '未来三天交期'}</Text><Button className={styles.textAction} onClick={() => setOrderAttention(null)}>清除筛选</Button></View>}<View className={styles.segment}><Button aria-pressed={recordView === 'activity'} className={recordView === 'activity' ? styles.selected : styles.button} onClick={() => setRecordView('activity')}>出入库 / 生产</Button><Button aria-pressed={recordView === 'orders'} className={recordView === 'orders' ? styles.selected : styles.button} onClick={() => setRecordView('orders')}>规格与订单</Button></View>
        {recordView === 'activity' && <View><View className={styles.tools}>{action('打印存根', () => open('/pages/print-center/index'))}{action('账单流水与收款', () => openFinance('ledger'))}{action('票据原件', () => changePanel('photos'))}</View>{data.production.map(p => <View className={styles.record} key={p.id}><strong>生产完工 · {p.product_name}</strong><Text>纸板 {p.specification_snapshot.board.join(' × ')} cm → 纸箱 {p.specification_snapshot.carton.join(' × ')} cm</Text><Text>领用 {p.consumed_quantity} 张 · 完工 {p.quantity} {p.unit}</Text><Text>{formatTime(p.created_at)} · {p.operator}</Text><Text>{p.id}</Text></View>)}{data.boards.map(b => <View className={styles.record} key={b.id}><strong>纸板入库 · {boardSpec(b)} cm</strong><Text>对应纸箱 {cartonSpec(b)} cm · 实收 {b.receivedQty} 张</Text><Text>送货日期 {b.date} · {b.supplier}</Text><Text>登记时间 {formatTime(b.createdAt)}</Text>{action('批次存根', () => open('/pages/management/index?section=paperboard-batch&id=' + b.id))}</View>)}{data.transactions.filter(t => !t.production_id && !t.voided_at).slice(0, 30).map(t => <View className={styles.record} key={t.id}><strong>{t.type === 'in' ? '入库' : t.type === 'out' ? '出库' : '盘点'} · {t.product_name}</strong><Text>{t.specification} · {t.quantity} {t.unit}</Text><Text>{formatTime(t.created_at)}</Text></View>)}{action('全部出入库记录', () => open('/pages/management/index?section=transactions'))}</View>}
        {recordView === 'orders' && <View><Input className={styles.input} aria-label='搜索订单' placeholder='搜索客户、规格或订单号' value={query} onInput={e => setQuery(e.detail.value)} /><View className={styles.segment}>{(['全部', '待发货', '待生产', '生产中', '已发货', '已完成', '已取消'] as const).map(value => <Button key={value} aria-pressed={orderStatus === value} className={orderStatus === value ? styles.selected : styles.button} onClick={() => setOrderStatus(value)}>{value}</Button>)}</View>{visibleOrders.filter(order => matches([order.order_no, order.customer_name, order.specification, order.material, order.status, order.remark].join(' '))).map(order => <View key={order.id} className={styles.record} data-testid='workbench-order'><strong>{order.customer_name} · {order.specification || '未填规格'}</strong><Text>{order.quantity} {order.unit} × {formatMoney(order.unit_price)} · 合计 {formatMoney(order.amount)}</Text><Text>交期 {order.delivery_date || '未设置'} · {order.status}</Text><Text>{order.order_no} · {formatTime(order.created_at)}</Text><View className={styles.tools}>{action('打印存根', () => open('/pages/print-center/index'))}{action('核对出库', () => { Taro.setStorageSync('sg_outbound_order', order.id); open('/pages/management/index?section=shipment'); }, true)}</View></View>)}{!visibleOrders.filter(order => matches([order.order_no, order.customer_name, order.specification, order.material, order.status, order.remark].join(' '))).length && <Text className={styles.empty}>没有找到匹配订单</Text>}</View>}
      </View>}
      {panel === 'photos' && <View><Text className={styles.note}>原件照片按业务账单保存；选择一笔账单，可上传送货单、签收单或付款凭证。</Text>{activeLedger.map(l => <Button className={styles.photoRow} key={l.id} onClick={() => openFinance('ledger', l.id)}><strong>{l.party_name || l.remark}</strong><Text>{formatTime(l.created_at)} · {formatMoney(l.amount)}</Text><Text>{l.attachments?.length ? l.attachments.length + ' 张原件照片' : '上传原件照片 ›'}</Text></Button>)}{!activeLedger.length && <Text className={styles.empty}>入库或出库保存后，账单会出现在这里。</Text>}</View>}
    </View>}
    </View>
    {moreOpen && <View className={styles.overlay}><View className={styles.dialog} role='dialog' aria-modal='true' aria-label='更多业务'><View className={styles.dialogHeading}><strong>更多</strong><Button aria-label='关闭更多业务' onClick={() => setMoreOpen(false)}>×</Button></View><View className={styles.moreMenu}>{[
      { title: '业务记录', fn: () => changePanel('records') },
      { title: '客户订单', fn: () => open('/pages/management/index?section=orders') },
      { title: '客户出库', fn: () => open('/pages/management/index?section=shipment') },
      { title: '扫码查库存', fn: () => open('/pages/management/index?section=stock-scanner') },
      { title: '商品资料', fn: () => open('/pages/management/index?section=goods') },
      { title: '纸箱计算器', fn: () => open('/pages/management/index?section=dimensions') },
      { title: '票据原件', fn: () => changePanel('photos') }
    ].map(item => <Button key={item.title} onClick={() => { setMoreOpen(false); item.fn(); }}>{item.title}<Icon name='chevron' color='#b2bfd0' style={{ width: 15, height: 15 }} /></Button>)}</View></View></View>}
    {stocktake && <View className={styles.overlay}><View className={styles.dialog} role='dialog' aria-label='库存盘点'><strong>{stocktake.product.name}</strong><View className={styles.stocktakeSummary}><Text>{stocktake.product.specification || '规格未填写'}</Text><Text>当前 {stocktake.product.stock} {stocktake.product.unit}</Text></View><Text className={styles.label}>新库存</Text><Input aria-label='实盘库存' className={styles.input} type='digit' placeholder='填写实际盘点数量' value={stocktakeValue} onInput={e => setStocktakeValue(e.detail.value)} /><Text className={styles.label}>盘点日期</Text><Picker mode='date' end={currentDate()} value={stocktakeDate} onChange={e => setStocktakeDate(e.detail.value)}><View aria-label='盘点日期' className={styles.input}>{stocktakeDate || '请选择日期'}</View></Picker><Input aria-label='盘点备注' className={styles.input} placeholder='备注（选填，如盘亏原因）' value={stocktakeRemark} onInput={e => setStocktakeRemark(e.detail.value)} />{stocktakeValue.trim() && /^\d+(?:\.\d{1,6})?$/.test(stocktakeValue.trim()) && <Text className={styles.note}>调整后库存 {stocktakeValue.trim()} {stocktake.product.unit}，盘点流水会同步保存。</Text>}{error && <View role='alert' className={styles.error}>{error}</View>}<View className={styles.tools}>{action('取消', () => { setStocktake(null); setError(''); })}{action(busy ? '保存中…' : '确认盘点', () => void submitStocktake(), true)}</View></View></View>}
    {editor && <CustomerEditor id={editor.id} supplier={editor.supplier} initialName={editor.initialName} lockName={editor.lockName} onClose={() => setEditor(null)} onSaved={async () => { setEditor(null); await reload(); }} />}
  </View></View>;
}
