import { useCallback, useEffect, useRef, useState } from 'react';
import { Button, Text, View } from '@tarojs/components';
import Taro, { useRouter, usePullDownRefresh } from '@tarojs/taro';
import { useSharedRefresh } from '../../services/shared-refresh';
import {
  buildBoardLabelSnapshot, buildFinishedLabelSnapshot,
  fetchLatestLabelRecord, parseLabelPageTarget, safeBoardMovements
} from '../../features/label-print';
import type { BoardLabelSnapshot, FinishedLabelSnapshot, LabelTarget, SafeBoardMovement } from '../../features/label-print';
import './style.scss';

type Detail = { kind: 'finished-product'; data: FinishedLabelSnapshot } | { kind: 'paperboard-batch'; data: BoardLabelSnapshot; movements: readonly SafeBoardMovement[] };

function currentTarget(params: Record<string, unknown>): LabelTarget {
  return parseLabelPageTarget(typeof window === 'undefined' ? undefined : window.location.href, params);
}

function errorMessage(error: unknown): string {
  const failure = error as { statusCode?: number; message?: string };
  if (failure?.statusCode === 404) return '这条仓库记录已删除或不存在，无法读取实时资料。';
  if (failure?.statusCode === 401 || failure?.statusCode === 403) return '当前连接无法访问这条记录，请恢复仓库连接后重试。';
  return failure?.message || '暂时无法读取实时资料，请检查网络后重试。';
}

export default function LabelResolver() {
  const { params } = useRouter();
  const [detail, setDetail] = useState<Detail | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');
  const [loadedAt, setLoadedAt] = useState('');
  const sequence = useRef(0);
  const routeKey = JSON.stringify(params);
  const load = useCallback(async () => {
    const request = ++sequence.current;
    setLoading(true); setError(''); setDetail(null);
    try {
      const target = currentTarget(JSON.parse(routeKey));
      let next: Detail;
      if (target.kind === 'finished-product') {
        const product = await fetchLatestLabelRecord(target.kind, target.id);
        next = { kind: target.kind, data: buildFinishedLabelSnapshot(product, { stockSnapshot: true }) };
      } else {
        const batch = await fetchLatestLabelRecord(target.kind, target.id);
        next = {
          kind: target.kind,
          data: buildBoardLabelSnapshot(batch, { receivedQty: true, remainingQtySnapshot: true, receivedDate: true, location: true }),
          movements: safeBoardMovements(batch.movements)
        };
      }
      if (sequence.current !== request) return;
      setDetail(next); setLoadedAt(new Date().toLocaleString('zh-CN'));
    } catch (failure) {
      if (sequence.current === request) setError(errorMessage(failure));
    } finally { if (sequence.current === request) setLoading(false); }
  }, [routeKey]);
  useEffect(() => { void load(); return () => { sequence.current += 1; }; }, [load]);
  useSharedRefresh(load);
  usePullDownRefresh(() => { void load().finally(() => Taro.stopPullDownRefresh()); });
  const row = (title: string, value: string | number) => <View className='label-resolver-row' key={title}><Text className='label-resolver-key'>{title}</Text><Text className='label-resolver-value'>{value}</Text></View>;
  return <View className='label-resolver-page'>
    <Text className='label-resolver-title'>标签实时详情</Text>
    <Text className='label-resolver-note'>本页只查询仓库记录，不会扣减库存。标签上的数量为打印时快照，实时数值以本页本次在线读取为准。</Text>
    {loading && <View className='label-resolver-card'><Text>正在在线读取最新资料…</Text></View>}
    {!loading && error && <View className='label-resolver-card label-resolver-error'><Text>{error}</Text><Button onClick={() => { void load(); }}>重新读取</Button></View>}
    {!loading && detail && <>
      <View className='label-resolver-card'>
        <Text className='label-resolver-section'>{detail.kind === 'finished-product' ? '成品' : '纸板批次'}</Text>
        {detail.kind === 'finished-product' ? <>
          {row('商品名称', detail.data.name)}
          {row('商品规格', detail.data.specification)}
          {row('商品 ID', detail.data.productId)}
          {row('当前库存', `${detail.data.stockSnapshot} ${detail.data.unit}`)}
        </> : <>
          {row('纸板规格', `${detail.data.boardLength} × ${detail.data.boardWidth} cm`)}
          {row('楞型', detail.data.fluteType)}
          {row('批次 ID', detail.data.batchId)}
          {row('板厂', detail.data.supplier)}
          {detail.data.receivedDate && row('入库日期', detail.data.receivedDate)}
          {detail.data.location && row('库位', detail.data.location)}
          {row('实收数量', `${detail.data.receivedQty} 张`)}
          {row('当前余量', `${detail.data.remainingQtySnapshot} 张`)}
        </>}
        <Text className='label-resolver-note'>读取时间：{loadedAt}</Text>
      </View>
      {detail.kind === 'paperboard-batch' && <View className='label-resolver-card'>
        <Text className='label-resolver-section'>数量流水</Text>
        {detail.movements.length === 0 ? <Text className='label-resolver-note'>暂无可显示的数量流水。</Text> : detail.movements.map((movement, index) => <View className='label-resolver-movement' key={`${movement.time}-${index}`}>
          <Text>{movement.type === 'in' ? '来料入库' : movement.type === 'out' ? '生产领料' : '盘点调整'} · {movement.type === 'out' ? '−' : movement.quantity >= 0 ? '+' : ''}{movement.quantity} 张</Text>
          <Text className='label-resolver-note'>{new Date(movement.time).toLocaleString('zh-CN')} · 结余 {movement.balance} 张</Text>
        </View>)}
      </View>}
      <Button className='label-resolver-refresh' onClick={() => { void load(); }}>刷新实时资料</Button>
    </>}
    <Text className='label-resolver-note label-resolver-access'>当前仓库为匿名共享访问；二维码仅用于定位记录，不是访问凭证。</Text>
  </View>;
}
