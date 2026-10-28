import { useCallback, useState } from 'react';
import { View, Text } from '@tarojs/components';
import Taro, { useDidShow, useRouter } from '@tarojs/taro';
import { BoardPage, BoardButton, BoardError } from '../../components/BoardUI';
import { BoardBatch, getBoard, boardSpec, cartonSpec, deleteBoard } from '../../services/boards';
import { useSharedRefresh } from '../../services/shared-refresh';
export default function BoardDetail() {
  const { params } = useRouter(); const id = params.id || '';
  const [batch, setBatch] = useState<BoardBatch | null>(null); const [error, setError] = useState('');
  const load = useCallback(async () => { try { setBatch(await getBoard(id)); setError(''); } catch (e) { setError(e.message); } }, [id]);
  useDidShow(load); useSharedRefresh(load);
  const remove = async () => {
    const result = await Taro.showModal({ title: '删除这批纸板？', content: '删除后将从库存和历史记录中移除。' });
    if (!result.confirm) return;
    try { await deleteBoard(id); void Taro.switchTab({ url: '/pages/inventory/index' }); }
    catch (e) { setError(e instanceof Error ? e.message : '删除失败'); }
  };
  const row = (title: string, value: string | number) => <View className='board-detail-row' key={title}><Text className='board-muted'>{title}</Text><Text>{value}</Text></View>;
  return <BoardPage title='这批纸板' subtitle={batch ? batch.supplier + ' · ' + batch.date + ' 到货' : '读取批次资料…'}>
    {error && <BoardError message={error} retry={load} />}
    {batch && <>
      {params.received === '1' && <Text className='board-note'>已入库。批次编号 {batch.id}</Text>}
      <View className='board-summary'><Text className='board-muted'>{boardSpec(batch)} cm · {batch.layers}层{batch.fluteType}楞</Text><Text className='board-summary-number'>{batch.remainingQty.toLocaleString()}<small>张剩余</small></Text><Text className='board-muted'>对应成箱 {cartonSpec(batch)} cm</Text></View>
      <View className='board-actions'><BoardButton secondary disabled={batch.boardDimensionsPending} onClick={() => Taro.navigateTo({ url: '/pages/label-print/index?kind=paperboard-batch&id=' + encodeURIComponent(batch.id) })}>{batch.boardDimensionsPending ? '补齐纸板尺寸后打印标签' : '打印批次标签'}</BoardButton><BoardButton disabled={batch.remainingQty === 0} onClick={() => Taro.navigateTo({ url: '/pages/board-outbound/index?id=' + id })}>领用这批纸板</BoardButton></View>
      <View className='board-detail-row'><Text>入库金额状态</Text><Text>{batch.amountMode === 'pending' ? '待补金额，未生成应付' : batch.amountMode === 'manual' ? '按本批金额入账' : '按平米计价'}</Text></View>
      <View className='board-section'><Text className='board-section-title'>来料信息</Text>{row('客户', batch.customerName || '未填写')}{row('材质/配纸', batch.material || '未填写')}{row('印刷版名', batch.printPlate || '未填写')}{row('颜色', batch.printColor || '未填写')}{row('板厂', batch.supplier)}{row('库位', batch.location || '未填写')}{row('送货单号', batch.deliveryNo || '未填写')}{row('登记时间', new Date(batch.createdAt).toLocaleString('zh-CN'))}{row('克重 g/m²', '面 ' + batch.faceGsm + ' / 里 ' + batch.linerGsm + ' / 楞 ' + batch.flutingGsm)}{row('订购 / 实收', batch.orderedQty + ' / ' + batch.receivedQty + ' 张')}{row('多送 / 少送', batch.giftQty + ' / ' + batch.shortageQty + ' 张')}{row('计费平米', batch.billedArea + ' m²')}{row('单价', '¥ ' + batch.unitPrice + ' / m²')}{row('本批货款', batch.amountMode === 'pending' ? '待补金额' : '¥ ' + batch.amount.toFixed(2))}{row('备注', batch.remark || '无')}<Text className='board-batch-id'>{id}</Text></View>
      <View className='board-section'><Text className='board-section-title'>出入库记录</Text>{batch.movements.map(m => <View className='board-timeline' key={m.id}><View className='board-row'><strong>{m.type === 'in' ? '来料入库' : m.type === 'out' ? '生产领料' : '盘点调整'}</strong><strong>{m.type === 'out' ? '−' : m.quantity >= 0 ? '+' : ''}{m.quantity} 张</strong></View><Text className='board-muted'>{m.date || new Date(m.createdAt).toLocaleString('zh-CN')} · 结余 {m.balance} 张</Text>{(m.remark || m.recipient) && <Text className='board-muted'>{[m.recipient, m.remark].filter(Boolean).join(' · ')}</Text>}</View>)}</View>
      <View className='board-actions'><BoardButton secondary onClick={() => Taro.navigateTo({ url: '/pages/board-receive/index?from=' + id })}>再进同规格</BoardButton><BoardButton secondary onClick={() => Taro.navigateTo({ url: '/pages/board-outbound/index?id=' + id + '&mode=count' })}>盘点这批</BoardButton></View>
      <View className='board-actions'><BoardButton secondary onClick={() => Taro.navigateTo({ url: '/pages/board-receive/index?id=' + encodeURIComponent(id) })}>编辑批次</BoardButton><BoardButton secondary onClick={() => void remove()}>删除批次</BoardButton></View>
    </>}
  </BoardPage>;
}
