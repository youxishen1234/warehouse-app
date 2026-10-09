import { View, Text } from '@tarojs/components';
import Taro from '@tarojs/taro';
import type { Transaction } from '@/types';
import { formatMoney } from '@/utils/format';
import styles from './index.module.scss';
import { moneyUpper } from '@/utils/dot-matrix-print';
export { moneyUpper } from '@/utils/dot-matrix-print';

export function OutboundDocument({ transactions, onClose }: { transactions: Transaction[]; onClose: () => void }) {
  const first = transactions[0], total = transactions.reduce((sum, tx) => sum + Number(tx.amount || 0), 0);
  const date = new Date(first.created_at);
  const print = () => {
    Taro.navigateTo({ url: `/pages/print-center/index?transaction_id=${first.id}` });
  };
  return <View className={styles.documentCard}>
    <View className={styles.documentActions}><Text className={styles.cardTitle}>送货单预览</Text><Text className={styles.link} onClick={onClose}>收起</Text></View>
    <View className={styles.paperScroll}><View className={styles.paper}>
      <Text className={styles.paperTitle}>出 库 单</Text>
      <View className={styles.paperMeta}><Text>单位：{first.customer_name || '未关联客户'}</Text><Text>{date.getFullYear()}年{date.getMonth() + 1}月{date.getDate()}日</Text><Text>编号：{first.outbound_no || `历史-${first.id}`}</Text></View>
      <View className={styles.paperMeta}><Text>关联订单：{first.order_no || '无'}</Text><Text>类别：成品出库</Text></View>
      <View className={styles.paperTable}><View className={styles.paperRow}>{['货号', '名称', '规格', '单位', '出库数量', '单价', '金额', '备注'].map(label => <Text key={label}>{label}</Text>)}</View>
        {transactions.map(tx => <View className={styles.paperRow} key={tx.id}><Text>{tx.product_id}</Text><Text>{tx.product_name}</Text><Text>{tx.specification || ''}</Text><Text>{tx.unit}</Text><Text>{tx.quantity}</Text><Text>{tx.unit_price}</Text><Text>{formatMoney(Number(tx.amount || 0))}</Text><Text>{tx.remark}</Text></View>)}
        {Array.from({ length: Math.max(0, 5 - transactions.length) }, (_, i) => <View className={styles.paperRow} key={`blank-${i}`}>{Array.from({ length: 8 }, (__, j) => <Text key={j}> </Text>)}</View>)}
        <View className={styles.paperTotal}><Text>合计金额（大写）：{moneyUpper(total)}</Text><Text>¥ {total.toFixed(2)}</Text></View>
      </View><View className={styles.paperMeta}><Text>主管：</Text><Text>仓库：</Text><Text>记账：</Text><Text>经手人：{first.operator}</Text></View>
    </View></View><View className={styles.documentActions}><Text className={styles.infoStock}>支持连续纸、位置校准与自动分页</Text><Text className={styles.tagOut} onClick={print}>针式打印 / 保存 PDF</Text></View>
  </View>;
}
