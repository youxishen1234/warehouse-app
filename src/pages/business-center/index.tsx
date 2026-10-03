import Taro from '@tarojs/taro';
import { View, Text } from '@tarojs/components';
import styles from './index.module.scss';

const entries = [
  ['纸板库存', '来料、领用与余量', '/pages/board-stock/index'],
  ['客户管理', '客户档案与往来账款', '/pages/customers/index'],
  ['订单出库', '订单、发货与送货单', '/pages/outbound/index'],
  ['账单流水', '收支明细与单据凭证照片', '/pages/ledger/index'],
];
export default function BusinessCenter() {
  const open = (url: string) => {
    const tabs = ['/pages/board-stock/index', '/pages/outbound/index'];
    if (tabs.includes(url)) void Taro.switchTab({ url });
    else void Taro.navigateTo({ url });
  };
  return <View className={styles.page}>
    <View className={styles.header}><View onClick={() => Taro.navigateBack()}><Text>‹ 返回</Text></View><Text className={styles.title}>业务中心</Text></View>
    <Text className={styles.subtitle}>纸板库存 · 客户管理 · 订单出库</Text>
    {entries.map(([title, detail, url]) => <View key={url} role='button' aria-label={`进入${title}`} className={styles.card} onClick={() => open(url)}>
      <View><Text className={styles.name}>{title}</Text><Text className={styles.detail}>{detail}</Text></View><Text>›</Text>
    </View>)}
  </View>;
}
