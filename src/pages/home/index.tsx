import { useSharedRefresh } from '@/services/shared-refresh';
import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { ScrollView, Text, View } from '@tarojs/components';
import Taro, { useDidShow, useDidHide } from '@tarojs/taro';
import { getStats } from '@/services/api';
import { loadProducts } from '@/services/product-store';
import type { Product, Stats } from '@/types';
import { formatMoney, getStockStatus } from '@/utils/format';
import Icon from '@/components/Icon';
import type { IconName } from '@/components/Icon';
import styles from './index.module.scss';

type QuickAction = { icon: IconName; text: string; url: string; color: string; bg: string };

const quickActions: QuickAction[] = [
  { icon: 'clipboard', text: '库存查询', url: '/pages/inventory/index', color: '#1677ff', bg: '#eaf3ff' },
  { icon: 'tag', text: '商品管理', url: '/pages/products/index', color: '#2563eb', bg: '#eaf3ff' },
  { icon: 'mine', text: '客户管理', url: '/pages/customers/index', color: '#0f766e', bg: '#e8f7f3' },
  { icon: 'mine', text: '供应商管理', url: '/pages/suppliers/index', color: '#16a34a', bg: '#eaf8ef' },
  { icon: 'records', text: '出入库记录', url: '/pages/records/index', color: '#0891b2', bg: '#e8f7fb' },
  { icon: 'plus', text: '新增商品', url: '/pages/product-edit/index', color: '#dc5c62', bg: '#fff0f1' },
  { icon: 'records', text: '流水', url: '/pages/ledger/index', color: '#7c3aed', bg: '#f2edff' },
  { icon: 'list', text: '客户订单', url: '/pages/orders/index', color: '#ea580c', bg: '#fff1e8' },
  { icon: 'box', text: '纸箱尺寸换算', url: '/pages/carton-calculator/index', color: '#0f766e', bg: '#e8f7f3' }
];

const WEEK = ['日', '一', '二', '三', '四', '五', '六'];
const tabUrls = new Set(['/pages/home/index', '/pages/inbound/index', '/pages/outbound/index', '/pages/mine/index']);

type LowStockRowProps = { product: Product };

const LowStockRow = React.memo(function LowStockRow({ product }: LowStockRowProps) {
  const status = getStockStatus(product.stock, product.safety_stock);
  return <View className={styles.warningRow}>
    <View className={styles.warningIcon}><Icon name="alert" color="#d58b12" /></View>
    <View className={styles.warningCopy}><Text className={styles.warningName}>{product.name}</Text><Text className={styles.warningMeta}>库存 {product.stock}{product.unit} · 安全库存 {product.safety_stock}{product.unit}</Text></View>
    <Text className={styles.warningTag} style={{ color: status.color }}>{status.label}</Text>
  </View>;
});

export default function HomePage() {
  const [stats, setStats] = useState<Stats | null>(null);
  const [lowStockList, setLowStockList] = useState<Product[]>([]);
  const [loading, setLoading] = useState(true);
  const [loadError, setLoadError] = useState('');
  const [today, setToday] = useState(() => new Date());
  const todayRef = useRef(today);
  const visible = useRef(true);
  const midnightTimer = useRef<ReturnType<typeof setTimeout>>();
  const requestId = useRef(0);
  const lastLoadAt = useRef(0);
  const didShowOnce = useRef(false);

  const loadData = useCallback(async (forceOrRevision: boolean | string = false) => {
    const startedAt = Date.now();
    const force = forceOrRevision === true || typeof forceOrRevision === 'string';
    if (!force && startedAt - lastLoadAt.current < 250) return;
    lastLoadAt.current = startedAt;
    const current = ++requestId.current;
    setLoading(true);
    try {
      const [nextStats, products] = await Promise.all([getStats(), loadProducts(force)]);
      if (current !== requestId.current) return;
      setStats(nextStats);
      setLowStockList(products.filter(product => {
        const safety = Number(product.safety_stock) || 0;
        return Number(product.stock || 0) <= (safety > 0 ? safety : 0);
      }).slice(0, 5));
      setLoadError('');
    } catch (error) {
      if (current === requestId.current) setLoadError(error instanceof Error ? error.message : '加载失败，请点击重试');
      console.error('[Home] loadData failed', error);
    } finally {
      if (current === requestId.current) setLoading(false);
    }
  }, []);

  const refreshDate = useCallback(() => {
    const next = new Date();
    if (next.toDateString() === todayRef.current.toDateString()) return false;
    todayRef.current = next;
    setToday(next);
    return true;
  }, []);

  const clearMidnightTimer = useCallback(() => {
    if (midnightTimer.current !== undefined) clearTimeout(midnightTimer.current);
    midnightTimer.current = undefined;
  }, []);

  const scheduleMidnight = useCallback(function schedule() {
    clearMidnightTimer();
    if (!visible.current || (typeof document !== 'undefined' && document.visibilityState === 'hidden')) return;
    const now = new Date();
    const nextDay = new Date(now.getFullYear(), now.getMonth(), now.getDate() + 1);
    midnightTimer.current = setTimeout(() => {
      if (refreshDate()) void loadData(true);
      schedule();
    }, nextDay.getTime() - now.getTime() + 25);
  }, [clearMidnightTimer, loadData, refreshDate]);

  useSharedRefresh(loadData);
  useEffect(() => { loadData(); }, [loadData]);
  useEffect(() => {
    const onVisible = () => {
      if (document.visibilityState === 'hidden') { clearMidnightTimer(); return; }
      if (visible.current && refreshDate()) void loadData(true);
      scheduleMidnight();
    };
    scheduleMidnight();
    if (typeof document !== 'undefined') document.addEventListener('visibilitychange', onVisible);
    return () => {
      requestId.current += 1;
      clearMidnightTimer();
      if (typeof document !== 'undefined') document.removeEventListener('visibilitychange', onVisible);
    };
  }, [clearMidnightTimer, loadData, refreshDate, scheduleMidnight]);
  useDidShow(() => {
    visible.current = true;
    refreshDate();
    scheduleMidnight();
    const firstShow = !didShowOnce.current;
    didShowOnce.current = true;
    // 首次展示与 useEffect 初始加载可能同时触发，避免重复请求。
    if (!firstShow || Date.now() - lastLoadAt.current >= 250) void loadData(true);
  });
  useDidHide(() => { visible.current = false; clearMidnightTimer(); });

  const goTo = (url: string) => {
    const task = tabUrls.has(url) ? Taro.switchTab({ url }) : Taro.navigateTo({ url });
    task.catch(error => console.error('[Home] navigation failed', url, error));
  };

  // The date label is derived from the midnight-aware `today` state. Memoizing
  // it keeps every stats refresh from rebuilding the string and indexing the
  // weekday table during the page's frequent shared-refresh renders.
  const dateText = useMemo(
    () => `${today.getMonth() + 1}月${today.getDate()}日 · 星期${WEEK[today.getDay()]}`,
    [today]
  );
  const todayIn = stats?.todayIn || 0;
  const todayOut = stats?.todayOut || 0;
  const flowMax = useMemo(() => Math.max(todayIn, todayOut, 1), [todayIn, todayOut]);

  return (
    <ScrollView scrollY className={styles.container} onRefresherRefresh={() => loadData(true)} refresherEnabled refresherTriggered={false}>
      <View className={styles.topbar}>
        <View>
          <Text className={styles.eyebrow}>仓库概览</Text>
          <Text className={styles.pageTitle}>今天，星期{WEEK[today.getDay()]}</Text>
        </View>
        <View className={styles.topbarActions}>
          <View className={styles.warehouseSwitch}><Text className={styles.warehouseDot} />一号仓</View>
          <View className={styles.bell} onClick={() => Taro.showToast({ title: '暂无新的提醒', icon: 'none' })}><Icon name="alert" color="#172235" /></View>
        </View>
      </View>

      <View className={styles.heroNote}>
        <View><Text className={styles.heroTitle}>直接进入功能</Text><Text className={styles.heroDate}>{dateText}</Text></View>
        <Text className={styles.linkButton} onClick={() => loadData(true)}>刷新</Text>
      </View>

      <View className={styles.actionGrid}>
        <View className={`${styles.actionCard} ${styles.actionIn}`} onClick={() => goTo('/pages/inbound/index')}>
          <View className={styles.actionIcon}><Icon name="inbound" color="#fff" /></View>
          <Text className={styles.actionTitle}>收货入库</Text>
          <Text className={styles.actionSubtitle}>选择供应商和已有商品</Text>
        </View>
        <View className={`${styles.actionCard} ${styles.actionOut}`} onClick={() => goTo('/pages/outbound/index')}>
          <View className={styles.actionIcon}><Icon name="outbound" color="#fff" /></View>
          <Text className={styles.actionTitle}>订单出库</Text>
          <Text className={styles.actionSubtitle}>选择客户和多商品明细</Text>
        </View>
      </View>

      <View className={styles.sectionHead}>
        <Text className={styles.sectionTitle}>功能入口</Text>
        <Text className={styles.linkButton} onClick={() => goTo('/pages/mine/index')}>资料管理</Text>
      </View>
      <View className={styles.funcGrid}>
        {quickActions.map(action => (
          <View key={action.url} className={styles.funcItem} onClick={() => goTo(action.url)}>
            <View className={styles.moduleIcon} style={{ background: action.bg }}><Icon name={action.icon} color={action.color} /></View>
            <Text className={styles.funcText}>{action.text}</Text>
          </View>
        ))}
      </View>

      <View className={styles.sectionHead}><Text className={styles.sectionTitle}>今日任务</Text><Text className={styles.cardCaption}>{loading ? '加载中…' : '实时数据'}</Text></View>
      <View className={styles.taskCard}>
        <View className={styles.taskItem} onClick={() => goTo('/pages/inbound/index')}><Text className={styles.taskNum}>{stats ? todayIn : '--'}</Text><Text className={styles.taskLabel}>今日入库</Text></View>
        <View className={styles.taskItem} onClick={() => goTo('/pages/outbound/index')}><Text className={styles.taskNum}>{stats ? todayOut : '--'}</Text><Text className={styles.taskLabel}>今日出库</Text></View>
        <View className={styles.taskItem} onClick={() => goTo('/pages/inventory/index')}><Text className={styles.taskNum}>{stats ? stats.totalProducts : '--'}</Text><Text className={styles.taskLabel}>商品种类</Text></View>
        <View className={`${styles.taskItem} ${styles.attention}`} onClick={() => goTo('/pages/inventory/index')}><Text className={styles.taskNum}>{stats ? stats.lowStock : '--'}</Text><Text className={styles.taskLabel}>库存预警</Text></View>
      </View>

      <View className={styles.sectionHead}><Text className={styles.sectionTitle}>库存流转</Text><Text className={styles.cardCaption}>今日数量</Text></View>
      <View className={styles.flowCard}>
        <View className={styles.flowLegend}><Text><Text className={styles.flowDotIn} />入库</Text><Text><Text className={styles.flowDotOut} />出库</Text><Text>单位：实际数量</Text></View>
        <View className={styles.flowRow} onClick={() => goTo('/pages/inbound/index')}><Text className={styles.flowLabel}>入库</Text><View className={styles.flowBar}><View className={styles.flowBarIn} style={{ width: `${Math.round(todayIn / flowMax * 100)}%` }} /></View><Text className={styles.flowValue}>{stats ? todayIn : '--'}</Text></View>
        <View className={styles.flowRow} onClick={() => goTo('/pages/outbound/index')}><Text className={styles.flowLabel}>出库</Text><View className={styles.flowBar}><View className={styles.flowBarOut} style={{ width: `${Math.round(todayOut / flowMax * 100)}%` }} /></View><Text className={styles.flowValue}>{stats ? todayOut : '--'}</Text></View>
      </View>

      <View className={styles.sectionHead}><Text className={styles.sectionTitle}>库存提醒</Text><Text className={styles.linkButton} onClick={() => goTo('/pages/inventory/index')}>查看库存</Text></View>
      {loadError && <View className={styles.errorBox} onClick={() => loadData(true)}>{loadError} · 点击重试</View>}
      {!loadError && lowStockList.length === 0 ? (
        <View className={styles.emptyCard}><Icon name="check" color="#23a26d" /><Text>暂无库存预警，当前库存正常</Text></View>
      ) : (
        <View className={styles.warningCard}>
          {lowStockList.map(product => <LowStockRow key={product.id} product={product} />)}
        </View>
      )}

      <View className={styles.footerNote}>曙光 · 让每一次流转都有迹可循 · 库存总值 {stats ? formatMoney(stats.totalValue) : '--'} · 应收 {stats ? formatMoney(stats.totalReceivable || 0) : '--'} · 应付 {stats ? formatMoney(stats.totalPayable || 0) : '--'}</View>
    </ScrollView>
  );
}
