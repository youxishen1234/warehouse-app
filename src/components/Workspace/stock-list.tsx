import { View, Text, Button } from '@tarojs/components';
import { useState } from 'react';
import type { BoardBatch } from '@/services/boards';
import { boardSpec, cartonSpec } from '@/services/boards';
import type { Product, Transaction } from '@/types';
import { formatMoney, formatTime } from '@/utils/format';
import { openBusinessPage } from '@/services/business-navigation';
import styles from '@/components/Workspace/workbench.module.scss';

export default function StockList({ kind, boards, cartons, transactions, onStocktake, onInbound }: {
  kind: 'all' | 'board' | 'carton';
  boards: BoardBatch[];
  cartons: Product[];
  transactions: Transaction[];
  onProduce: (id: string) => void;
  onStocktake: (product: Product) => void;
  onInbound: (product: Product) => void;
}) {
  const [selected, setSelected] = useState<Product>();
  return <View>
    {kind !== 'carton' && boards.map(batch => <Button className={styles.stockCard} key={batch.id} data-testid='workbench-board' data-record-id={batch.id} onClick={() => void openBusinessPage('/pages/management/index?section=paperboard-batch&id=' + encodeURIComponent(batch.id))}>
      <View className={styles.stockTop}><View className={styles.avatar}>板</View><View className={styles.stockIdentity}><strong>{batch.layers}层 {batch.fluteType}楞纸板</strong><Text>{boardSpec(batch)} cm</Text><Text>成箱 {cartonSpec(batch)} cm</Text><Text>入库：{batch.date}</Text><Text>入库金额：{batch.amountMode === 'pending' ? '待核算' : formatMoney(batch.amount)}</Text></View><View className={styles.stockAmount}>{batch.remainingQty.toLocaleString()} <Text>张</Text></View></View>
      <View className={styles.stockBottom}><View><Text>客户：{batch.customerName || '公共备货'}</Text><Text>供货来源：{batch.supplier || '未关联供货商'}</Text><Text>库位：{batch.location || '未设库位'}</Text></View><Text>查看明细 ›</Text></View>
    </Button>)}
    {kind !== 'board' && cartons.map(product => {
    const receipts = transactions.filter(row => row.product_id === product.id && row.type === 'in' && !row.voided_at);
    const customers = [...new Set([product.customer_name, ...receipts.map(row => row.customer_name)].filter(Boolean))];
    const suppliers = [...new Set(receipts.map(row => row.supplier_name).filter(Boolean))];
    const latest = receipts.reduce<Transaction | undefined>((last, row) => !last || row.created_at > last.created_at ? row : last, undefined);
    return <Button key={product.id} className={styles.stockCard} data-testid='workbench-carton' onClick={() => setSelected(product)}>
      <View className={styles.stockTop}><View className={styles.avatar}>箱</View><View className={styles.stockIdentity}><strong>{product.name}</strong><Text>{product.specification}</Text>{latest && <Text>入库：{formatTime(latest.created_at)}</Text>}</View><View className={styles.stockAmount}>{product.stock.toLocaleString()} <Text>{product.unit}</Text></View></View>
      <View className={styles.stockBottom}><View><Text>客户：{customers.join('、') || '公共备货'}</Text><Text>供货来源：{suppliers.join('、') || (receipts.some(row => row.production_id) ? '自产' : '未关联供货商')}</Text></View><Text>查看明细 ›</Text></View>
    </Button>;
  })}
  {selected && <View className={styles.overlay}><View className={styles.dialog} role='dialog' aria-modal='true' aria-label='库存明细'>
    <View className={styles.dialogHeading}><strong>{selected.name}</strong><Button aria-label='关闭库存明细' onClick={() => setSelected(undefined)}>×</Button></View>
    <View className={styles.detailRow}><Text>规格</Text><Text>{selected.specification}</Text></View><View className={styles.detailRow}><Text>当前库存</Text><Text>{selected.stock} {selected.unit}</Text></View>
    <View className={styles.detailRow}><Text>安全库存</Text><Text>{selected.safety_stock ?? 0} {selected.unit}</Text></View>
    <View className={styles.tools}><Button className={styles.primary} onClick={() => { setSelected(undefined); onInbound(selected); }}>同规格入库</Button><Button className={styles.button} onClick={() => { setSelected(undefined); onStocktake(selected); }}>库存盘点</Button><Button className={styles.button} onClick={() => void openBusinessPage('/pages/management/index?section=labels&kind=finished-product&id=' + selected.id)}>标签打印</Button></View>
    <Button className={styles.textAction} onClick={() => void openBusinessPage('/pages/management/index?section=transactions&type=in&product_id=' + selected.id)}>入库单据与金额 ›</Button>
  </View></View>}
  </View>;
}
