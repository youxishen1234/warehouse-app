/* eslint-disable react/forbid-elements */
import { useCallback, useState } from 'react';
import Taro, { useDidShow, useRouter } from '@tarojs/taro';
import { DemoSheet, DemoDetail } from '@/components/DemoUI';
import { BoardBatch, getBoard, boardSpec, cartonSpec, deleteBoard } from '@/services/boards';
import { useSharedRefresh } from '@/services/shared-refresh';
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
  const row = (title: string, value: string | number) => <DemoDetail label={title} key={title}>{value}</DemoDetail>;
  const go = (section: string, extra = '') => void Taro.navigateTo({ url: `/pages/management/index?section=${section}&id=${encodeURIComponent(id)}${extra}` });
  return <DemoSheet title={batch ? batch.name || `${batch.layers}层 ${batch.fluteType}楞纸板` : '纸板库存明细'} testId='paperboard-detail-sheet'>
    {error && <div className='demo-error' role='alert'>{error}<button type='button' className='demo-action' onClick={() => void load()}>重新读取</button></div>}
    {!batch && !error && <p>正在读取批次资料…</p>}
    {batch && <>
      {row('规格', `${boardSpec(batch)} cm`)}{row('对应成箱', `${cartonSpec(batch)} cm`)}
      {row('入库日期时间', batch.enteredAt?.replace('T', ' ') || batch.date)}{row('系统登记时间', new Date(batch.createdAt).toLocaleString('zh-CN'))}
      {row('入库金额', batch.amountMode === 'pending' ? '未记录 / 待核算' : `¥ ${batch.amount.toFixed(2)}`)}
      {row('采购单价', `¥ ${batch.unitPrice} / ㎡`)}{row('总面积', `${batch.billedArea} ㎡`)}
      {row('当前库存', `${batch.remainingQty} 张`)}{row('安全库存', `${batch.warningQty} 张`)}
      {row('库位', batch.location || '未填写')}{row('关联客户', batch.customerName || '公共备货')}{row('供货来源', batch.supplier || '未关联供货商')}
      <p>数量变化记录</p>{batch.movements.map(movement => row(`${movement.type === 'in' ? '来料入库' : movement.type === 'out' ? '生产领料' : '盘点调整'} · ${movement.date || new Date(movement.createdAt).toLocaleDateString('zh-CN')}`, `${movement.type === 'out' ? '−' : '+'}${movement.quantity} 张`))}
      <div className='demo-two'><button type='button' className='demo-primary' onClick={() => void Taro.navigateTo({ url: '/pages/board-inbound/index?from=' + encodeURIComponent(id) })}>同规格入库</button><button type='button' className='demo-primary demo-secondary' onClick={() => go('paperboard-movement', '&mode=count')}>库存盘点</button></div>
      <details className='demo-more'><summary>批次操作</summary><div className='demo-menu'>
        <button type='button' disabled={batch.remainingQty === 0} onClick={() => void Taro.navigateTo({ url: '/pages/production-inbound/index?batch_id=' + encodeURIComponent(id) })}>生产入库<span>›</span></button>
        <button type='button' disabled={batch.remainingQty === 0} onClick={() => go('paperboard-movement')}>领用这批纸板<span>›</span></button>
        <button type='button' disabled={batch.boardDimensionsPending} onClick={() => go('labels', '&kind=paperboard-batch')}>打印批次标签<span>›</span></button>
        <button type='button' onClick={() => void Taro.navigateTo({ url: '/pages/board-inbound/index?id=' + encodeURIComponent(id) })}>编辑批次<span>›</span></button><button type='button' onClick={() => void remove()}>删除批次<span>›</span></button>
      </div><p>{id}</p>{row('材质 / 配纸', batch.material || '未填写')}{row('送货单号', batch.deliveryNo || '未填写')}{row('备注', batch.remark || '未填写')}</details>
    </>}
  </DemoSheet>;
}
