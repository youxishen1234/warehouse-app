import { useCallback, useEffect, useState } from 'react';
import { View, Text } from '@tarojs/components';
import Taro, { useDidShow, useRouter } from '@tarojs/taro';
import QRCode from 'qrcode';
import { BoardPage, BoardButton, BoardError } from '../../components/BoardUI';
import { BoardBatch, getBoard, boardSpec, cartonSpec, boardLink } from '../../services/boards';
import { useSharedRefresh } from '../../services/shared-refresh';
export default function BoardDetail() {
  const { params } = useRouter(); const id = params.id || '';
  const [batch, setBatch] = useState<BoardBatch | null>(null); const [error, setError] = useState(''); const [qr, setQr] = useState(''); const [label, setLabel] = useState(false);
  const load = useCallback(async () => { try { setBatch(await getBoard(id)); setError(''); } catch (e) { setError(e.message); } }, [id]);
  useDidShow(load); useSharedRefresh(load);
  useEffect(() => { let active = true; QRCode.toDataURL(boardLink(id), { width: 600, margin: 4, errorCorrectionLevel: 'M' }).then(url => { if (active) setQr(url); }).catch(() => setError('标签生成失败，请重新打开此页')); return () => { active = false; }; }, [id]);
  const download = async () => {
    if (!batch || !qr) return;
    try {
      const canvas = document.createElement('canvas'); canvas.width = 800; canvas.height = 1000;
      const ctx = canvas.getContext('2d'); if (!ctx) throw new Error('当前设备无法生成标签');
      ctx.fillStyle = '#fff'; ctx.fillRect(0, 0, 800, 1000); ctx.fillStyle = '#15291f'; ctx.textAlign = 'center';
      const img = new window.Image(); img.src = qr; await img.decode(); ctx.drawImage(img, 100, 30, 600, 600);
      ctx.font = 'bold 36px sans-serif'; ctx.fillText(boardSpec(batch) + ' cm · ' + batch.fluteType + '楞', 400, 665);
      ctx.font = '26px sans-serif'; ctx.fillText('成箱 ' + cartonSpec(batch) + ' cm', 400, 710); ctx.fillText(batch.supplier, 400, 755, 730);
      ctx.fillText(batch.date + ' · 实收 ' + batch.receivedQty + ' 张', 400, 800); ctx.fillText('库位：' + (batch.location || '未填写'), 400, 845, 730);
      ctx.font = '20px monospace'; ctx.fillText(batch.id, 400, 890); ctx.font = '22px sans-serif'; ctx.fillText('扫一扫查看实时余量与领料记录', 400, 945);
      const blob = await new Promise<Blob | null>(resolve => canvas.toBlob(resolve, 'image/png'));
      if (!blob) throw new Error('生成图片失败');
      const file = new File([blob], batch.id + '.png', { type: 'image/png' });
      if (navigator.canShare?.({ files: [file] })) { await navigator.share({ files: [file], title: '纸板批次标签' }); return; }
      const a = document.createElement('a'); const url = URL.createObjectURL(blob); a.href = url; a.download = file.name; a.click(); setTimeout(() => URL.revokeObjectURL(url), 10000);
    } catch (e) { if (e.name !== 'AbortError') setError(e.message || '无法保存标签，可长按二维码保存或使用打印'); }
  };
  const row = (title: string, value: string | number) => <View className='board-detail-row' key={title}><Text className='board-muted'>{title}</Text><Text>{value}</Text></View>;
  return <BoardPage title='这批纸板' subtitle={batch ? batch.supplier + ' · ' + batch.date + ' 到货' : '读取批次资料…'}>
    {error && <BoardError message={error} retry={load} />}
    {batch && <>
      {params.received === '1' && <Text className='board-note'>已入库。保存下方标签，贴到这批纸板上。</Text>}
      <View className='board-summary'><Text className='board-muted'>{boardSpec(batch)} cm · {batch.layers}层{batch.fluteType}楞</Text><Text className='board-summary-number'>{batch.remainingQty.toLocaleString()}<small>张剩余</small></Text><Text className='board-muted'>对应成箱 {cartonSpec(batch)} cm</Text></View>
      <View className='board-actions'><BoardButton disabled={batch.remainingQty === 0} onClick={() => Taro.navigateTo({ url: '/pages/board-outbound/index?id=' + id })}>领用这批纸板</BoardButton><BoardButton secondary onClick={() => setLabel(!label)}>{label ? '收起标签' : '查看 / 保存标签'}</BoardButton></View>
      {label && <><View className='board-label'>{qr && <img src={qr} alt={'纸板批次二维码 ' + id} />}<strong>{boardSpec(batch)} cm · {batch.fluteType}楞</strong><Text className='board-card-meta'>成箱 {cartonSpec(batch)} cm</Text><Text className='board-card-meta'>{batch.supplier} · {batch.date}</Text><Text className='board-card-meta'>实收 {batch.receivedQty} 张 · {batch.location || '未填写库位'}</Text><Text className='board-batch-id'>{id}</Text><Text className='board-muted'>扫码看实时库存，标签数量为入库时实收数</Text></View><View className='board-actions'><BoardButton onClick={download}>保存 / 分享标签</BoardButton><BoardButton secondary onClick={() => window.print()}>打印标签</BoardButton></View></>}
      <View className='board-section'><Text className='board-section-title'>来料信息</Text>{row('板厂', batch.supplier)}{row('库位', batch.location || '未填写')}{row('送货单号', batch.deliveryNo || '未填写')}{row('克重 g/m²', '面 ' + batch.faceGsm + ' / 里 ' + batch.linerGsm + ' / 楞 ' + batch.flutingGsm)}{row('订购 / 实收', batch.orderedQty + ' / ' + batch.receivedQty + ' 张')}{row('多送 / 少送', batch.giftQty + ' / ' + batch.shortageQty + ' 张')}{row('计费平米', batch.billedArea + ' m²')}{row('单价', '¥ ' + batch.unitPrice + ' / m²')}{row('本批货款', '¥ ' + batch.amount.toFixed(2))}{row('备注', batch.remark || '无')}<Text className='board-batch-id'>{id}</Text></View>
      <View className='board-section'><Text className='board-section-title'>出入库记录</Text>{batch.movements.map(m => <View className='board-timeline' key={m.id}><View className='board-row'><strong>{m.type === 'in' ? '来料入库' : m.type === 'out' ? '生产领料' : '盘点调整'}</strong><strong>{m.type === 'out' ? '−' : m.quantity >= 0 ? '+' : ''}{m.quantity} 张</strong></View><Text className='board-muted'>{m.date || new Date(m.createdAt).toLocaleString('zh-CN')} · 结余 {m.balance} 张</Text>{(m.remark || m.recipient) && <Text className='board-muted'>{[m.recipient, m.remark].filter(Boolean).join(' · ')}</Text>}</View>)}</View>
      <View className='board-actions'><BoardButton secondary onClick={() => Taro.navigateTo({ url: '/pages/board-receive/index?from=' + id })}>再进同规格</BoardButton><BoardButton secondary onClick={() => Taro.navigateTo({ url: '/pages/board-outbound/index?id=' + id + '&mode=count' })}>盘点这批</BoardButton></View>
    </>}
  </BoardPage>;
}
