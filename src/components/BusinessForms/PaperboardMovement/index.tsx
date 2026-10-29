/* eslint-disable react/forbid-elements */
import { useRef, useState } from 'react';
import Taro, { useLoad, useRouter } from '@tarojs/taro';
import { DemoSheet, DemoField, DemoDetail } from '@/components/DemoUI';
import { BoardBatch, getBoards, moveBoard, boardSpec, cartonSpec } from '@/services/boards';
import { useSharedRefresh } from '@/services/shared-refresh';
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
    try { await moveBoard(id, { type: count ? 'count' : 'out', quantity: n, recipient, remark }); await Taro.redirectTo({ url: '/pages/management/index?section=paperboard-batch&id=' + id }); } catch (e) { setError(e.message); try { setBatches(await getBoards()); } catch { /* keep the form for retry */ } } finally { saving.current = false; setBusy(false); }
  };
  return <DemoSheet title={count ? '库存盘点' : '纸板领料'} busy={busy}>
    {!eligible.length && loaded && !error && <div className='demo-empty'>暂无可领用纸板<button type='button' className='demo-primary' onClick={() => void Taro.navigateTo({ url: '/pages/board-inbound/index' })}>纸板入库</button></div>}
    {!!eligible.length && <DemoField label='纸板批次'><select aria-label='选择纸板批次' disabled={busy} value={id} onChange={event => setId(event.target.value)}><option value=''>请选择批次</option>{eligible.map(item => <option value={item.id} key={item.id}>{boardSpec(item)} cm · {item.supplier} · 余 {item.remainingQty} 张</option>)}</select></DemoField>}
    {batch && <><p>{cartonSpec(batch)} cm · {batch.supplier}</p><DemoDetail label='当前库存'>{batch.remainingQty} 张</DemoDetail>
      <DemoField label={count ? '实盘数量（张）' : '领料数量（张）'}><input type='number' step='1' min='0' aria-label={count ? '实盘数量' : '领料数量'} value={quantity} disabled={busy} onChange={event => setQuantity(event.target.value)} /></DemoField>
      <DemoField label={count ? '盘点原因' : '用途备注'}><input aria-label={count ? '盘点原因' : '用途备注'} value={remark} disabled={busy} onChange={event => setRemark(event.target.value)} /></DemoField>
      {!count && <DemoField label='领料人'><input aria-label='领料人' value={recipient} disabled={busy} onChange={event => setRecipient(event.target.value)} /></DemoField>}
      <div className='demo-note'>{count ? '盘点后结余' : '领用后结余'}：{quantity && Number.isFinite(after) ? after : '—'} 张</div>
    </>}
    {error && <div className='demo-error' role='alert'>{error}{!batches.length && <button type='button' className='demo-action' onClick={() => void load()}>重新读取</button>}</div>}
    {batch && <button type='button' className='demo-primary' disabled={busy} onClick={() => void save()}>{busy ? '正在保存…' : count ? '确认盘点调整' : '确认领料'}</button>}
  </DemoSheet>;
}
