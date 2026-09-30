import React, { useState } from 'react';
import { View, Text, ScrollView, Button } from '@tarojs/components';
import Taro from '@tarojs/taro';
import styles from './index.module.scss';

// 模拟数据
const mockBoardStock = [
  {
    id: 1,
    boardLength: 165,
    boardWidth: 115,
    fluteType: 'B',
    faceGsm: 150,
    linerGsm: 150,
    flutingGsm: 120,
    cartonLength: 40,
    cartonWidth: 30,
    cartonHeight: 20,
    currentStock: 1004,
    maxStock: 1200,
    supplier: 'XX纸业',
    lastInboundDate: '9月28日',
    lastInboundQty: 1004,
    monthInbound: 2000,
    monthOutbound: 1496,
    status: 'ok'
  },
  {
    id: 2,
    boardLength: 140,
    boardWidth: 100,
    fluteType: 'A',
    faceGsm: 130,
    linerGsm: 130,
    flutingGsm: 110,
    cartonLength: 35,
    cartonWidth: 25,
    cartonHeight: 18,
    currentStock: 280,
    maxStock: 300,
    supplier: 'YY纸板厂',
    lastInboundDate: '9月20日',
    lastInboundQty: 500,
    monthInbound: 800,
    monthOutbound: 520,
    status: 'warning'
  }
];

export default function BoardStock() {
  const [filter, setFilter] = useState('all');

  const filteredStock = mockBoardStock.filter(item => {
    if (filter === 'all') return true;
    if (filter === 'ok') return item.status === 'ok';
    if (filter === 'warning') return item.status === 'warning';
    return true;
  });

  const totalSpecs = mockBoardStock.length;
  const totalQty = mockBoardStock.reduce((sum, item) => sum + item.currentStock, 0);
  const warningCount = mockBoardStock.filter(item => item.status === 'warning').length;

  const handleScan = () => {
    Taro.showToast({ title: '扫码功能开发中', icon: 'none' });
  };

  const handleInbound = (board) => {
    Taro.navigateTo({ url: '/pages/board-inbound/index' });
  };

  const handleOutbound = (board) => {
    Taro.navigateTo({ url: '/pages/board-outbound/index' });
  };

  const handleDetail = (board) => {
    Taro.showToast({ title: '详情功能开发中', icon: 'none' });
  };

  const handleQRCode = (board) => {
    Taro.showToast({ title: '二维码功能开发中', icon: 'none' });
  };

  return (
    <View className={styles.page}>
      <View className={styles.navbar}>
        <View className={styles.navbarContent}>
          <Text className={styles.navbarTitle}>纸板库存</Text>
          <View className={styles.navbarActions}>
            <View className={styles.iconBtn} onClick={handleScan}>📱</View>
            <View className={styles.iconBtn} onClick={() => Taro.navigateTo({ url: '/pages/board-inbound/index' })}>➕</View>
          </View>
        </View>
      </View>

      <View className={styles.filters}>
        <View 
          className={`${styles.filterBtn} ${filter === 'all' ? styles.active : ''}`}
          onClick={() => setFilter('all')}
        >
          全部
        </View>
        <View 
          className={`${styles.filterBtn} ${filter === 'ok' ? styles.active : ''}`}
          onClick={() => setFilter('ok')}
        >
          充足
        </View>
        <View 
          className={`${styles.filterBtn} ${filter === 'warning' ? styles.active : ''}`}
          onClick={() => setFilter('warning')}
        >
          预警
        </View>
      </View>

      <ScrollView scrollY className={styles.content}>
        {/* 总览卡片 */}
        <View className={styles.overviewCard}>
          <Text className={styles.overviewTitle}>📊 库存总览</Text>
          <View className={styles.overviewGrid}>
            <View className={styles.overviewItem}>
              <Text className={styles.overviewValue}>{totalSpecs}</Text>
              <Text className={styles.overviewLabel}>种规格</Text>
            </View>
            <View className={styles.overviewItem}>
              <Text className={styles.overviewValue}>{totalQty}</Text>
              <Text className={styles.overviewLabel}>总库存（张）</Text>
            </View>
            <View className={styles.overviewItem}>
              <Text className={styles.overviewValue}>{warningCount}</Text>
              <Text className={styles.overviewLabel}>库存不足</Text>
            </View>
          </View>
        </View>

        <View className={styles.sectionHeader}>
          <Text className={styles.sectionTitle}>{filteredStock.length}种规格</Text>
        </View>

        {/* 纸板卡片列表 */}
        {filteredStock.map(board => (
          <View 
            key={board.id} 
            className={`${styles.boardCard} ${board.status === 'warning' ? styles.warning : ''}`}
          >
            <View className={styles.boardHeader}>
              <View className={styles.boardTitleRow}>
                <Text className={styles.boardName}>
                  {board.boardLength}×{board.boardWidth} cm
                </Text>
                <View className={`${styles.statusBadge} ${board.status === 'ok' ? styles.ok : styles.warningBadge}`}>
                  {board.status === 'ok' ? '✓ 库存充足' : '⚠️ 库存不足'}
                </View>
              </View>
              <View className={styles.boardSubtitle}>
                <Text>→ {board.cartonLength}×{board.cartonWidth}×{board.cartonHeight} 纸箱</Text>
                <View className={styles.supplierTag}>{board.supplier}</View>
              </View>
            </View>

            <View className={styles.boardBody}>
              <View className={styles.infoRow}>
                <Text className={styles.infoLabel}>纸板规格</Text>
                <Text className={styles.infoValue}>三层{board.fluteType}楞</Text>
              </View>

              <View className={styles.infoRow}>
                <Text className={styles.infoLabel}>克重配置</Text>
                <Text className={styles.infoValue}>
                  面{board.faceGsm} + 里{board.linerGsm} + 楞{board.flutingGsm}
                </Text>
              </View>

              <View className={styles.infoRow}>
                <Text className={styles.infoLabel}>供应商</Text>
                <Text className={styles.infoValue}>{board.supplier}</Text>
              </View>

              <View className={styles.infoRow}>
                <Text className={styles.infoLabel}>最近入库</Text>
                <Text className={styles.infoValue}>
                  {board.lastInboundDate} · {board.lastInboundQty}张
                </Text>
              </View>

              <View className={styles.progressSection}>
                <View className={styles.progressHeader}>
                  <Text className={styles.progressLabel}>当前库存</Text>
                  <Text className={styles.progressValue}>
                    {board.currentStock} / {board.maxStock} 张
                  </Text>
                </View>
                <View className={styles.progressBar}>
                  <View 
                    className={`${styles.progressFill} ${board.status === 'warning' ? styles.warningFill : ''}`}
                    style={{ width: `${(board.currentStock / board.maxStock) * 100}%` }}
                  />
                </View>
              </View>

              <View className={styles.statsGrid}>
                <View className={styles.statCard}>
                  <Text className={styles.statValue}>{board.monthInbound}</Text>
                  <Text className={styles.statLabel}>本月入库</Text>
                </View>
                <View className={styles.statCard}>
                  <Text className={styles.statValue}>{board.monthOutbound}</Text>
                  <Text className={styles.statLabel}>本月领料</Text>
                </View>
              </View>

              {board.status === 'warning' && (
                <View className={styles.alertBox}>
                  <Text className={styles.alertTitle}>⚠️ 低于安全库存</Text>
                  <Text className={styles.alertText}>建议采购 500张，预计3天后用完</Text>
                </View>
              )}

              <View className={styles.actionRow}>
                {board.status === 'warning' ? (
                  <>
                    <View className={styles.actionBtnPrimary} onClick={() => handleInbound(board)}>
                      立即入库
                    </View>
                    <View className={styles.actionBtn} onClick={() => handleDetail(board)}>
                      详情
                    </View>
                    <View className={styles.actionBtn} onClick={() => handleQRCode(board)}>
                      二维码
                    </View>
                  </>
                ) : (
                  <>
                    <View className={styles.actionBtn} onClick={() => handleInbound(board)}>
                      入库
                    </View>
                    <View className={styles.actionBtn} onClick={() => handleOutbound(board)}>
                      领料
                    </View>
                    <View className={styles.actionBtn} onClick={() => handleDetail(board)}>
                      详情
                    </View>
                    <View className={styles.actionBtn} onClick={() => handleQRCode(board)}>
                      二维码
                    </View>
                  </>
                )}
              </View>
            </View>
          </View>
        ))}

        <View className={styles.bottomSpace} />
      </ScrollView>
    </View>
  );
}
