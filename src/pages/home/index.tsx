import React, { useState, useEffect, useCallback } from 'react';
import { View, Text, Input, ScrollView } from '@tarojs/components';
import Taro, { useDidShow } from '@tarojs/taro';
import { getStats, getProducts, getCustomers } from '@/services/api';
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

// 搜索可匹配的功能入口（输入关键词即显示，点击直达）
const searchableActions: { text: string; keywords: string[]; icon: IconName; color: string; url: string }[] = [
  { text: '采购入库', keywords: ['入库', '采购', '进货', '入库登记'], icon: 'inbound', color: '#16a34a', url: '/pages/inbound/index' },
  { text: '销售出库', keywords: ['出库', '销售', '出货', '出库登记'], icon: 'outbound', color: '#2f6bff', url: '/pages/outbound/index' },
  { text: '库存查询', keywords: ['库存', '查询', '盘点', '库存查询'], icon: 'clipboard', color: '#7c3aed', url: '/pages/inventory/index' },
  { text: '客户管理', keywords: ['客户', '客户管理', '供应商'], icon: 'mine', color: '#0d9488', url: '/pages/customers/index' },
  { text: '商品管理', keywords: ['商品', '商品管理', '产品'], icon: 'tag', color: '#d97706', url: '/pages/products/index' },
  { text: '出入库记录', keywords: ['记录', '流水', '出入库记录', '历史'], icon: 'records', color: '#0891b2', url: '/pages/records/index' },
  { text: '新增商品', keywords: ['新增', '添加商品', '新建商品'], icon: 'plus', color: '#ef4444', url: '/pages/product-edit/index' },
];

const WEEK = ['日', '一', '二', '三', '四', '五', '六'];

const HomePage: React.FC = () => {
  const [stats, setStats] = useState<Stats | null>(null);
  const [lowStockList, setLowStockList] = useState<Product[]>([]);
  const [searchKeyword, setSearchKeyword] = useState('');
  const [searchProducts, setSearchProducts] = useState<Product[]>([]);
  const [searchCustomers, setSearchCustomers] = useState<{ id: number; name: string }[]>([]);
  const searchShortcuts = [
    { text: '入库登记', url: '/pages/inbound/index', icon: 'inbound' as IconName, color: '#16a34a' },
    { text: '出库登记', url: '/pages/outbound/index', icon: 'outbound' as IconName, color: '#2f6bff' },
    { text: '出入库记录', url: '/pages/records/index', icon: 'records' as IconName, color: '#0891b2' },
    { text: '商品管理', url: '/pages/products/index', icon: 'tag' as IconName, color: '#d97706' }
  ];
  const [searchActions, setSearchActions] = useState<typeof searchableActions>([]);

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

  useDidShow(() => {
    loadData();
  });

  useEffect(() => {
    const kw = searchKeyword.trim();
    if (!kw) {
      setSearchProducts([]);
      setSearchCustomers([]);
      setSearchActions([]);
      return;
    }
    // 匹配功能入口
    const matched = searchableActions.filter(a =>
      a.text.includes(kw) || a.keywords.some(k => k.includes(kw) || kw.includes(k))
    );
    const prioritized = kw.includes('入库')
      ? [...matched.filter(a => a.text.includes('入库')), ...matched.filter(a => !a.text.includes('入库'))]
      : matched;
    setSearchActions(prioritized);
    Promise.all([getProducts(kw), getCustomers(kw)])
      .then(([products, customers]) => {
        setSearchProducts(products.slice(0, 5));
        setSearchCustomers(customers.slice(0, 5));
      })
      .catch(error => console.error('[Home] search failed', error));
  }, [searchKeyword]);

  const goTo = (url: string) => {
    const tabUrls = new Set(['/pages/home/index', '/pages/inbound/index', '/pages/outbound/index', '/pages/mine/index']);
    const task = tabUrls.has(url) ? Taro.switchTab({ url }) : Taro.navigateTo({ url });
    task.catch(error => console.error('[Home] navigation failed', url, error));
  };

  const handleMetricClick = (url: string) => {
    goTo(url);
  };

  const openSearchResult = (url: string) => {
    setSearchKeyword('');
    setSearchProducts([]);
    setSearchCustomers([]);
    setSearchActions([]);
    goTo(url);
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
          <View className={styles.todayItem} onClick={() => handleMetricClick('/pages/inbound/index')}>
            <Text className={styles.todayNum}>{stats ? stats.todayIn : '--'}</Text>
            <Text className={styles.todayLabel}>今日入库</Text>
          </View>
          <View className={styles.todayDivider} />
          <View className={styles.todayItem} onClick={() => handleMetricClick('/pages/outbound/index')}>
            <Text className={styles.todayNum}>{stats ? stats.todayOut : '--'}</Text>
            <Text className={styles.todayLabel}>今日出库</Text>
          </View>
          <View className={styles.todayDivider} />
          <View className={styles.todayItem} onClick={() => handleMetricClick('/pages/inventory/index')}>
            <Text className={styles.todayNumWarn}>{stats ? stats.lowStock : '--'}</Text>
            <Text className={styles.todayLabel}>库存预警</Text>
          </View>
        </View>
      </View>

      <View className={styles.searchCard}>
        <Icon name="search" color="#8b95a7" className={styles.searchIcon} />
        <Input
          className={styles.searchInput}
          placeholder="搜索商品、客户或功能（入库/出库/库存…）"
          value={searchKeyword}
          onInput={e => setSearchKeyword(e.detail.value)}
        />
      </View>
      {(searchActions.length > 0 || searchProducts.length > 0 || searchCustomers.length > 0 || searchKeyword.trim()) && (
        <View className={styles.searchResults}>
          {searchActions.length > 0 && (
            <View className={styles.searchActionGroup}>
              <Text className={styles.searchGroupLabel}>功能入口</Text>
              {searchActions.map(a => (
                <View key={`action-${a.text}`} className={styles.searchResult} onClick={() => openSearchResult(a.url)}>
                  <View className={styles.searchActionIcon} style={{ background: a.color + '1a' }}>
                    <Icon name={a.icon} color={a.color} className={styles.searchResultIcon} />
                  </View>
                  <Text className={styles.searchActionText}>{a.text}</Text>
                  <Text className={styles.searchActionArrow}>›</Text>
                </View>
              ))}
            </View>
          )}
          {searchProducts.length > 0 && (
            <View className={styles.searchActionGroup}>
              <Text className={styles.searchGroupLabel}>商品</Text>
              {searchProducts.map(p => (
                <View key={`product-${p.id}`} className={styles.searchResult} onClick={() => openSearchResult('/pages/products/index')}>
                  <Icon name="tag" color="#d97706" className={styles.searchResultIcon} />
                  <Text>{p.name} · 商品管理</Text>
                </View>
              ))}
            </View>
          )}
          {searchCustomers.length > 0 && (
            <View className={styles.searchActionGroup}>
              <Text className={styles.searchGroupLabel}>客户</Text>
              {searchCustomers.map(c => (
                <View key={`customer-${c.id}`} className={styles.searchResult} onClick={() => openSearchResult('/pages/customers/index')}>
                  <Icon name="mine" color="#0d9488" className={styles.searchResultIcon} />
                  <Text>{c.name} · 客户管理</Text>
                </View>
              ))}
            </View>
          )}
          {!searchActions.length && !searchProducts.length && !searchCustomers.length && <Text className={styles.searchEmpty}>没有找到匹配的内容</Text>}
        </View>
      )}

      {/* ===== 经营概览 ===== */}
      <View className={styles.overviewCard}>
        <View className={styles.cardTitleRow}>
          <Text className={styles.cardTitle} onClick={() => handleMetricClick('/pages/inventory/index')}>经营概览</Text>
          <Text className={styles.cardMore} onClick={() => handleMetricClick('/pages/inventory/index')}>点击查看库存 ›</Text>
        </View>
        <View className={styles.overviewGrid}>
          <View className={styles.overviewItem} onClick={() => handleMetricClick('/pages/products/index')}>
            <View className={styles.overviewIcon} style={{ background: 'rgba(47,107,255,0.14)' }}>
              <Icon name="tag" color="#2f6bff" className={styles.overviewIconImg} />
            </View>
            <View className={styles.overviewInfo}>
              <Text className={styles.overviewLabel}>商品种类</Text>
              <Text className={styles.overviewValue}>{stats ? stats.totalProducts : 0}</Text>
            </View>
          </View>
          <View className={styles.overviewItem} onClick={() => handleMetricClick('/pages/inventory/index')}>
            <View className={styles.overviewIcon} style={{ background: 'rgba(124,58,237,0.14)' }}>
              <Icon name="box" color="#7c3aed" className={styles.overviewIconImg} />
            </View>
            <View className={styles.overviewInfo}>
              <Text className={styles.overviewLabel}>库存总量</Text>
              <Text className={styles.overviewValue}>{stats ? stats.totalStock : 0}</Text>
            </View>
          </View>
          <View className={styles.overviewItem} onClick={() => goTo('/pages/inventory/index')}>
            <View className={styles.overviewIcon} style={{ background: 'rgba(22,163,74,0.14)' }}>
              <Icon name="money" color="#16a34a" className={styles.overviewIconImg} />
            </View>
            <View className={styles.overviewInfo}>
              <Text className={styles.overviewLabel}>库存总值</Text>
              <Text className={styles.overviewValueSmall}>{stats ? formatMoney(stats.totalValue) : '¥0'}</Text>
            </View>
          </View>
          <View className={styles.overviewItem} onClick={() => handleMetricClick('/pages/inventory/index')}>
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
