import { View, Text, Button } from '@tarojs/components';
import type { BoardBatch } from '@/services/boards';
import { boardSpec, cartonSpec } from '@/services/boards';
import type { Product, Transaction } from '@/types';
import { formatMoney, formatTime } from '@/utils/format';
import { openBusinessPage } from '@/services/business-navigation';
import styles from './workbench.module.scss';

export default function StockList({ kind, boards, cartons, transactions, onProduce, onStocktake, onInbound }: {
  kind: 'board' | 'carton';
  boards: BoardBatch[];
  cartons: Product[];
  transactions: Transaction[];
  onProduce: (id: string) => void;
  onStocktake: (product: Product) => void;
  onInbound: (product: Product) => void;
}) {
  if (kind === 'board') return <View>{boards.map(batch => <View className={styles.row} key={batch.id} data-testid='workbench-board'>
    <View><strong>{boardSpec(batch)} cm</strong><Text>成箱 {cartonSpec(batch)} cm</Text>
      <Text>客户：{batch.customerName || '公共备货'}</Text><Text>供货商：{batch.supplier || '未填写'}</Text>
      <Text>{batch.fluteType}楞 · {batch.layers}层 · {batch.location || '未设库位'}</Text>
      <Text>入库 {batch.date} · 登记 {formatTime(batch.createdAt)}</Text>
      <Text>本批入库金额 {batch.amountMode === 'pending' ? '待补金额' : formatMoney(batch.amount)}</Text><Text>{batch.deliveryNo || batch.id}</Text>
    </View><View><strong>{batch.remainingQty} 张</strong>
      <Button className={styles.button} onClick={() => void openBusinessPage('/pages/board-detail/index?id=' + encodeURIComponent(batch.id))}>查看 / 同规格入库</Button>
      <Button className={styles.button} onClick={() => onProduce(batch.id)}>生产</Button>
    </View>
  </View>)}</View>;
  return <View>{cartons.map(product => {
    const receipts = transactions.filter(row => row.product_id === product.id && row.type === 'in' && !row.voided_at);
    const customers = [...new Set([product.customer_name, ...receipts.map(row => row.customer_name)].filter(Boolean))];
    const suppliers = [...new Set(receipts.map(row => row.supplier_name).filter(Boolean))];
    const latest = receipts.reduce<Transaction | undefined>((last, row) => !last || row.created_at > last.created_at ? row : last, undefined);
    return <View key={product.id} className={styles.row} data-testid='workbench-carton'>
      <View><strong>{product.name}</strong><Text>{product.specification || '规格未填写'}</Text>
        <Text>关联客户：{customers.join('、') || '公共备货'}</Text>
        <Text>入库来源：{suppliers.join('、') || (receipts.some(row => row.production_id) ? '自产入库' : '未登记供货商')}</Text>
        {latest && <Text>最近入库 {formatTime(latest.created_at)}</Text>}
        {customers.length > 1 || suppliers.length > 1 ? <Text>含多个往来单位，按入库单核对来源</Text> : null}
        <Button className={styles.textAction} onClick={() => void openBusinessPage('/pages/records/index?type=in&product_id=' + product.id)}>入库单据与金额</Button>
      </View><View><strong>{product.stock} {product.unit}</strong>
        <Button className={styles.primary} onClick={() => onStocktake(product)}>盘点 / 调整库存</Button>
        <Button className={styles.button} onClick={() => onInbound(product)}>入库</Button>
        <Button className={styles.button} onClick={() => void openBusinessPage('/pages/label-print/index?kind=finished-product&id=' + product.id)}>标签</Button>
      </View>
    </View>;
  })}</View>;
}
