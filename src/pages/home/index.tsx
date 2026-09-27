import { useSharedRefresh } from '@/services/shared-refresh';
import React, { useCallback, useEffect, useRef, useState } from 'react';
import { ScrollView, Text, View } from '@tarojs/components';
import Taro, { useDidShow } from '@tarojs/taro';
import { getProducts, getStats } from '@/services/api';
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

export default function HomePage() {
  const [stats, setStats] = useState<Stats | null>(null);
  const [lowStockList, setLowStockList] = useState<Product[]>([]);
  const [loading, setLoading] = useState(true);
  const [loadError, setLoadError] = useState('');
  const requestId = useRef(0);

  const loadData = useCallback(async () => {
    const current = ++requestId.current;
    setLoading(true);
    try {
      const [nextStats, products] = await Promise.all([getStats(), getProducts()]);
      if (current !== requestId.current) return;
      setStats(nextStats);
      setLowStockList(products.filter(product => product.stock <= product.safety_stock).slice(0, 5));
      setLoadError('');
    } catch (error) {
      if (current === requestId.current) setLoadError(error instanceof Error ? error.message : '加载失败，请点击重试');
      console.error('[Home] loadData failed', error);
    } finally {
      if (current === requestId.current) setLoading(false);
    }
  }, []);

  useSharedRefresh(loadData);
  useEffect(() => { loadData(); }, [loadData]);
  useDidShow(() => { loadData(); });

  const goTo = (url: string) => {
    const task = tabUrls.has(url) ? Taro.switchTab({ url }) : Taro.navigateTo({ url });
    task.catch(error => console.error('[Home] navigation failed', url, error));
  };

  const today = new Date();
  const dateText = `${today.getMonth() + 1}月${today.getDate()}日 · 星期${WEEK[today.getDay()]}`;
  const todayIn = stats?.todayIn || 0;
  const todayOut = stats?.todayOut || 0;
  const flowMax = Math.max(todayIn, todayOut, 1);

  return (
    <ScrollView scrollY className={styles.container} onRefresherRefresh={loadData} refresherEnabled refresherTriggered={false}>
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
        <Text className={styles.linkButton} onClick={loadData}>刷新</Text>
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
      {loadError && <View className={styles.errorBox} onClick={loadData}>{loadError} · 点击重试</View>}
      {!loadError && lowStockList.length === 0 ? (
        <View className={styles.emptyCard}><Icon name="check" color="#23a26d" /><Text>暂无库存预警，当前库存正常</Text></View>
      ) : (
        <View className={styles.warningCard}>
          {lowStockList.map(product => {
            const status = getStockStatus(product.stock, product.safety_stock);
            return <View key={product.id} className={styles.warningRow}><View className={styles.warningIcon}><Icon name="alert" color="#d58b12" /></View><View className={styles.warningCopy}><Text className={styles.warningName}>{product.name}</Text><Text className={styles.warningMeta}>库存 {product.stock}{product.unit} · 安全库存 {product.safety_stock}{product.unit}</Text></View><Text className={styles.warningTag} style={{ color: status.color }}>{status.label}</Text></View>;
          })}
        </View>
      )}

      <View className={styles.footerNote}>曙光 · 让每一次流转都有迹可循 · 库存总值 ¥{stats ? formatMoney(stats.totalValue) : '--'}</View>
    </ScrollView>
  );
}
