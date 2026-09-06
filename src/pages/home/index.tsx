import React, { useState, useEffect, useCallback } from 'react';
import { View, Text, ScrollView } from '@tarojs/components';
import Taro from '@tarojs/taro';
import { getStats, getProducts } from '@/services/api';
import { formatMoney, getStockStatus } from '@/utils/format';
import type { Stats, Product } from '@/types';
import Icon from '@/components/Icon';
import type { IconName } from '@/components/Icon';
import styles from './index.module.scss';

// 常用功能宫格（进销存标准入口）
const quickActions: { icon: IconName; text: string; url: string; color: string; bg: string }[] = [
  { icon: 'inbound', text: '采购入库', url: '/pages/inbound/index', color: '#16a34a', bg: 'rgba(22,163,74,0.14)' },
  { icon: 'outbound', text: '销售出库', url: '/pages/outbound/index', color: '#2f6bff', bg: 'rgba(47,107,255,0.14)' },
  { icon: 'clipboard', text: '库存查询', url: '/pages/inventory/index', color: '#7c3aed', bg: 'rgba(124,58,237,0.14)' },
  { icon: 'mine', text: '客户管理', url: '/pages/customers/index', color: '#0d9488', bg: 'rgba(13,148,136,0.14)' },
  { icon: 'tag', text: '商品管理', url: '/pages/products/index', color: '#d97706', bg: 'rgba(217,119,6,0.14)' },
  { icon: 'records', text: '出入库记录', url: '/pages/records/index', color: '#0891b2', bg: 'rgba(8,145,178,0.14)' },
  { icon: 'plus', text: '新增商品', url: '/pages/product-edit/index', color: '#ef4444', bg: 'rgba(239,68,68,0.14)' }
];

const WEEK = ['日', '一', '二', '三', '四', '五', '六'];

const HomePage: React.FC = () => {
  const [stats, setStats] = useState<Stats | null>(null);
  const [lowStockList, setLowStockList] = useState<Product[]>([]);

  const loadData = useCallback(async () => {
    try {
      const [s, products] = await Promise.all([getStats(), getProducts()]);
      setStats(s);
      setLowStockList(products.filter(p => p.stock <= p.safety_stock).slice(0, 5));
    } catch (e) {
      console.error('[Home] loadData failed', e);
    }
  }, []);

  useEffect(() => {
    loadData();
  }, [loadData]);

  const goTo = (url: string) => {
    Taro.navigateTo({ url });
  };

  const today = new Date();
  const dateStr = `${today.getMonth() + 1}月${today.getDate()}日 · 周${WEEK[today.getDay()]}`;

  return (
    <ScrollView scrollY className={styles.container} onRefresherRefresh={loadData} refresherEnabled refresherTriggered={false}>
      {/* ===== 顶部蓝色经营区 ===== */}
      <View className={styles.header}>
        <View className={styles.headerTop}>
          <View>
            <Text className={styles.headerTitle}>曙光库存</Text>
            <Text className={styles.headerDate}>{dateStr}</Text>
          </View>
        </View>
        <View className={styles.todayBar}>
          <View className={styles.todayItem}>
            <Text className={styles.todayNum}>{stats ? stats.todayIn : '--'}</Text>
            <Text className={styles.todayLabel}>今日入库</Text>
          </View>
          <View className={styles.todayDivider} />
          <View className={styles.todayItem}>
            <Text className={styles.todayNum}>{stats ? stats.todayOut : '--'}</Text>
            <Text className={styles.todayLabel}>今日出库</Text>
          </View>
          <View className={styles.todayDivider} />
          <View className={styles.todayItem}>
            <Text className={styles.todayNumWarn}>{stats ? stats.lowStock : '--'}</Text>
            <Text className={styles.todayLabel}>库存预警</Text>
          </View>
        </View>
      </View>

      {/* ===== 经营概览 ===== */}
      <View className={styles.overviewCard}>
        <Text className={styles.cardTitle}>经营概览</Text>
        <View className={styles.overviewGrid}>
          <View className={styles.overviewItem}>
            <View className={styles.overviewIcon} style={{ background: 'rgba(47,107,255,0.14)' }}>
              <Icon name="tag" color="#2f6bff" className={styles.overviewIconImg} />
            </View>
            <View className={styles.overviewInfo}>
              <Text className={styles.overviewLabel}>商品种类</Text>
              <Text className={styles.overviewValue}>{stats ? stats.totalProducts : 0}</Text>
            </View>
          </View>
          <View className={styles.overviewItem}>
            <View className={styles.overviewIcon} style={{ background: 'rgba(124,58,237,0.14)' }}>
              <Icon name="box" color="#7c3aed" className={styles.overviewIconImg} />
            </View>
            <View className={styles.overviewInfo}>
              <Text className={styles.overviewLabel}>库存总量</Text>
              <Text className={styles.overviewValue}>{stats ? stats.totalStock : 0}</Text>
            </View>
          </View>
          <View className={styles.overviewItem}>
            <View className={styles.overviewIcon} style={{ background: 'rgba(22,163,74,0.14)' }}>
              <Icon name="money" color="#16a34a" className={styles.overviewIconImg} />
            </View>
            <View className={styles.overviewInfo}>
              <Text className={styles.overviewLabel}>库存总值</Text>
              <Text className={styles.overviewValueSmall}>{stats ? formatMoney(stats.totalValue) : '¥0'}</Text>
            </View>
          </View>
          <View className={styles.overviewItem}>
            <View className={styles.overviewIcon} style={{ background: 'rgba(239,68,68,0.14)' }}>
              <Icon name="alert" color="#ef4444" className={styles.overviewIconImg} />
            </View>
            <View className={styles.overviewInfo}>
              <Text className={styles.overviewLabel}>预警商品</Text>
              <Text className={styles.overviewValueWarn}>{stats ? stats.lowStock : 0}</Text>
            </View>
          </View>
        </View>
      </View>

      {/* ===== 常用功能 ===== */}
      <View className={styles.funcCard}>
        <Text className={styles.cardTitle}>常用功能</Text>
        <View className={styles.funcGrid}>
          {quickActions.map(a => (
            <View key={a.text} className={styles.funcItem} onClick={() => goTo(a.url)}>
              <View className={styles.funcIcon} style={{ background: a.bg }}>
                <Icon name={a.icon} color={a.color} className={styles.funcIconImg} />
              </View>
              <Text className={styles.funcText}>{a.text}</Text>
            </View>
          ))}
        </View>
      </View>

      {/* ===== 库存预警 ===== */}
      <View className={styles.warnCard}>
        <View className={styles.cardTitleRow}>
          <Text className={styles.cardTitle}>库存预警</Text>
          <Text className={styles.cardMore} onClick={() => goTo('/pages/inventory/index')}>查看全部 ›</Text>
        </View>
        {lowStockList.length === 0 ? (
          <View className={styles.emptyBox}>
            <Icon name="check" color="#16a34a" className={styles.emptyIcon} />
            <Text className={styles.emptyText}>暂无预警商品，库存状况良好</Text>
          </View>
        ) : (
          lowStockList.map(p => {
            const status = getStockStatus(p.stock, p.safety_stock);
            return (
              <View key={p.id} className={styles.warnItem}>
                <View className={styles.warnLeft}>
                  <Text className={styles.warnName}>{p.name}</Text>
                  <Text className={styles.warnStock}>库存 {p.stock}{p.unit} / 安全 {p.safety_stock}{p.unit}</Text>
                </View>
                <Text className={styles.warnTag} style={{ background: status.color + '1a', color: status.color }}>{status.label}</Text>
              </View>
            );
          })
        )}
      </View>
    </ScrollView>
  );
};

export default HomePage;
