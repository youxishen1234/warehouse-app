import { useRef, useState } from 'react';
import { View, Text, Picker } from '@tarojs/components';
import Taro, { useLoad, useRouter } from '@tarojs/taro';
import { BoardPage, BoardButton, BoardField, BoardEmpty, BoardError } from '../../components/BoardUI';
import { BoardBatch, getBoards, moveBoard, boardSpec, cartonSpec } from '../../services/boards';
import { useSharedRefresh } from '../../services/shared-refresh';
export default function BoardOutbound() {
  const { params } = useRouter(); const count = params.mode === 'count';
  const [batches, setBatches] = useState<BoardBatch[]>([]); const [id, setId] = useState(params.id || '');
  const [quantity, setQuantity] = useState(''); const [recipient, setRecipient] = useState(''); const [remark, setRemark] = useState('');
  const [error, setError] = useState(''); const [busy, setBusy] = useState(false); const [loaded, setLoaded] = useState(false); const saving = useRef(false);
  const load = async () => { try { setBatches(await getBoards()); setError(''); } catch (e) { setError(e.message); } finally { setLoaded(true); } };
  useLoad(load);
  useSharedRefresh(load);
  const eligible = batches.filter(b => count || b.remainingQty > 0 || b.id === id);
  const batch = batches.find(b => b.id === id); const n = Number(quantity);
  const after = batch ? (count ? n : batch.remainingQty - n) : 0;
  const save = async () => {
    if (saving.current) return;
    if (!batch) { setError('请先选择一批纸板'); return; }
    if (!quantity.trim() || !Number.isSafeInteger(n) || n < 0 || (!count && n === 0)) { setError(count ? '请输入非负整数的实盘数量' : '请输入正整数的领料数量'); return; }
    if (!count && n > batch.remainingQty) { setError('领料不能超过当前库存 ' + batch.remainingQty + ' 张'); return; }
    if (count && !remark.trim()) { setError('请填写盘点原因'); return; }
    saving.current = true; setBusy(true); setError('');
    try { await moveBoard(id, { type: count ? 'count' : 'out', quantity: n, recipient, remark }); await Taro.redirectTo({ url: '/pages/board-detail/index?id=' + id }); } catch (e) { setError(e.message); try { setBatches(await getBoards()); } catch { /* keep the form for retry */ } } finally { saving.current = false; setBusy(false); }
  };
  return <BoardPage title={count ? '盘点这批纸板' : '纸板领料'} subtitle={count ? '填写实际数到的数量，保留调整记录。' : '确认批次和数量，再从库存中扣减。'}>
    {!eligible.length && loaded && !error && <BoardEmpty title='暂无可领用纸板' hint='先记一笔来料，库存就会出现在这里。'><BoardButton onClick={() => Taro.navigateTo({ url: '/pages/board-receive/index' })}>来料入库</BoardButton></BoardEmpty>}
    {eligible.length > 0 && <View className='board-section'><Text className='board-section-title'>选择批次</Text><Picker mode='selector' value={Math.max(0, eligible.findIndex(b => b.id === id) + 1)} range={['请选择批次', ...eligible.map(b => boardSpec(b) + ' · ' + b.supplier + ' · ' + b.date + ' · 余' + b.remainingQty + '张 · ' + b.id.slice(-6))]} onChange={e => setId(eligible[Number(e.detail.value) - 1]?.id || '')}><View className='board-input-wrap'>{batch ? boardSpec(batch) + ' cm · ' + batch.fluteType + '楞' : '请选择这次使用的纸板 ›'}</View></Picker>{batch && <><Text className='board-card-meta'>成箱 {cartonSpec(batch)} cm</Text><Text className='board-card-meta'>{batch.supplier} · {batch.date} · {batch.location || '未填写库位'}</Text><Text className='board-batch-id'>{batch.id}</Text><View className='board-detail-row'><Text>当前库存</Text><strong>{batch.remainingQty} 张</strong></View></>}</View>}
    {batch && <><View className='board-section'><BoardField label={count ? '实盘数量' : '领料数量'} numeric unit='张' value={quantity} onChange={setQuantity} /><View className='board-detail-row'><Text>{count ? '盘点后结余' : '领用后结余'}</Text><strong>{quantity && Number.isFinite(after) ? after : '—'} 张</strong></View></View><View className='board-section'><BoardField label='领料人' optional value={recipient} onChange={setRecipient} /><BoardField label={count ? '盘点原因' : '用途备注'} optional={!count} value={remark} onChange={setRemark} placeholder={count ? '例如：重新清点，发现少了 2 张' : '例如：生产、试样、报废'} /></View></>}
    {error && <BoardError message={error} retry={!loaded || !batches.length ? load : undefined} />}
    {batch && <BoardButton disabled={busy} onClick={save}>{busy ? '正在保存…' : count ? '确认盘点调整' : '确认领料'}</BoardButton>}
  </BoardPage>;
}
