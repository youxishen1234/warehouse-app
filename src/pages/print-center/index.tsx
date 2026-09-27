import { useEffect, useState } from 'react';
import { View, Text, ScrollView } from '@tarojs/components';
import Taro from '@tarojs/taro';
import { getTransactions } from '@/services/api';
import type { Transaction } from '@/types';
import styles from './index.module.scss';

export default function PrintCenterPage() {
  const [list, setList] = useState<Transaction[]>([]);
  useEffect(() => { getTransactions().then(setList).catch(() => Taro.showToast({ title: '流水加载失败', icon: 'none' })); }, []);
  const print = () => { const browser = globalThis as any; if (browser.print) browser.print(); };
  return <ScrollView scrollY className={styles.page}><View className={styles.toolbar}><Text className={styles.title}>打印中心</Text><View className={styles.printBtn} onClick={print}>打印当前流水</View></View><Text className={styles.hint}>浏览器端调用系统打印；移动端可使用系统分享或网页打印。</Text><View className={styles.sheet}><Text className={styles.sheetTitle}>出入库流水</Text>{list.length === 0 ? <Text>暂无流水</Text> : list.map(item => <View className={styles.row} key={item.id}><Text>{new Date(item.created_at).toLocaleString()}</Text><Text>{item.type === 'in' ? '入库' : item.type === 'out' ? '出库' : '盘点'}</Text><Text>{item.product_name || '商品'}</Text><Text>{item.quantity}</Text><Text>¥{Number(item.amount || 0).toFixed(2)}</Text></View>)}</View></ScrollView>;
}
