/* eslint-disable react/forbid-elements */
import { View, Text, Button } from '@tarojs/components';
import { useState } from 'react';
import { DemoSheet, DemoDetail } from '@/components/DemoUI';
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
      <View className={styles.stockTop}><View className={styles.avatar}>板</View><View className={styles.stockIdentity}><strong>{batch.name || `${batch.layers}层 ${batch.fluteType}楞纸板`}</strong><Text>{boardSpec(batch)} cm</Text><Text>成箱 {cartonSpec(batch)} cm</Text><Text>入库：{batch.enteredAt?.replace('T', ' ') || batch.date}</Text><Text>入库金额：{batch.amountMode === 'pending' ? '待核算' : formatMoney(batch.amount)}</Text></View><View className={styles.stockAmount}>{batch.remainingQty.toLocaleString()} <Text>张</Text></View></View>
      <View className={styles.stockBottom}><View><Text>客户：{batch.customerName || '公共备货'}</Text><Text>供货来源：{batch.supplier || '未关联供货商'}</Text><Text>库位：{batch.location || '未设库位'}</Text></View><Text>查看明细 ›</Text></View>
    </Button>)}
    {kind !== 'board' && cartons.map(product => {
    const receipts = transactions.filter(row => row.product_id === product.id && row.type === 'in' && !row.voided_at);
    const customers = [...new Set([product.customer_name, ...receipts.map(row => row.customer_name)].filter(Boolean))];
    const suppliers = [...new Set(receipts.map(row => row.supplier_name).filter(Boolean))];
    const latest = receipts.reduce<Transaction | undefined>((last, row) => !last || row.created_at > last.created_at ? row : last, undefined);
    return <Button key={product.id} className={styles.stockCard} data-testid='workbench-carton' onClick={() => setSelected(product)}>
      <View className={styles.stockTop}><View className={styles.avatar}>箱</View><View className={styles.stockIdentity}><strong>{product.name}</strong><Text>{product.specification}</Text>{latest && <Text>入库：{latest.entered_at?.replace('T', ' ') || formatTime(latest.created_at)}</Text>}</View><View className={styles.stockAmount}>{product.stock.toLocaleString()} <Text>{product.unit}</Text></View></View>
      <View className={styles.stockBottom}><View><Text>客户：{customers.join('、') || '公共备货'}</Text><Text>供货来源：{suppliers.join('、') || (receipts.some(row => row.production_id) ? '自产' : '未关联供货商')}</Text><Text>库位：{latest?.location || '未设库位'}</Text></View><Text>查看明细 ›</Text></View>
    </Button>;
  })}
  {selected && <DemoSheet title={selected.name} onClose={() => setSelected(undefined)} testId='carton-stock-detail'>
    <DemoDetail label='规格'>{selected.specification || '未填写'}</DemoDetail>
    {(() => { const latest = transactions.filter(row => row.product_id === selected.id && row.type === 'in' && !row.voided_at).sort((a, b) => b.created_at - a.created_at)[0]; return <><DemoDetail label='入库日期时间'>{latest?.entered_at?.replace('T', ' ') || (latest ? formatTime(latest.created_at) : '未记录')}</DemoDetail><DemoDetail label='系统登记时间'>{latest ? formatTime(latest.created_at) : '未记录'}</DemoDetail><DemoDetail label='库位'>{latest?.location || '未设库位'}</DemoDetail></>; })()}
    <DemoDetail label='当前库存'>{selected.stock} {selected.unit}</DemoDetail>
    <DemoDetail label='安全库存'>{selected.safety_stock ?? 0} {selected.unit}</DemoDetail>
    <DemoDetail label='关联客户'>{selected.customer_name || '公共备货'}</DemoDetail>
    <DemoDetail label='供货来源'>{[...new Set(transactions.filter(row => row.product_id === selected.id && row.type === 'in' && !row.voided_at).map(row => row.supplier_name).filter(Boolean))].join('、') || '自产 / 未关联供货商'}</DemoDetail>
    <p>数量变化记录</p>{transactions.filter(row => row.product_id === selected.id && !row.voided_at).map(row => <DemoDetail key={row.id} label={`${row.type === 'in' ? '入库' : row.type === 'out' ? '出库' : '盘点'} · ${formatTime(row.created_at)}`}>{row.type === 'out' ? '−' : '+'}{row.type === 'adjustment' ? row.adjustment ?? row.quantity : row.quantity} {row.unit}</DemoDetail>)}
    <div className='demo-two'><button type='button' className='demo-primary' onClick={() => { setSelected(undefined); onInbound(selected); }}>同规格入库</button><button type='button' className='demo-primary demo-secondary' onClick={() => { setSelected(undefined); onStocktake(selected); }}>库存盘点</button></div>
    <details className='demo-more'><summary>更多操作</summary><div className='demo-menu'><button type='button' onClick={() => void openBusinessPage('/pages/management/index?section=labels&kind=finished-product&id=' + selected.id)}>标签打印<span>›</span></button><button type='button' onClick={() => void openBusinessPage('/pages/management/index?section=transactions&type=in&product_id=' + selected.id)}>入库单据与金额<span>›</span></button></div></details>
  </DemoSheet>}

  </View>;
}
