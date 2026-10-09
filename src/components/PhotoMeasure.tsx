import { useEffect, useRef, useState } from 'react';
import { View, Text } from '@tarojs/components';
import Taro from '@tarojs/taro';
import { BoardButton, BoardField } from './BoardUI';
type Point = { x: number; y: number };
export default function PhotoMeasure() {
  const [url, setUrl] = useState(''); const currentUrl = useRef('');
  const [points, setPoints] = useState<Point[]>([]); const [reference, setReference] = useState('30');
  const [scale, setScale] = useState(0); const [measured, setMeasured] = useState<string[]>([]); const [error, setError] = useState('');
  const canvas = useRef<HTMLCanvasElement>(null); const picture = useRef<HTMLImageElement | null>(null);
  useEffect(() => () => { if (currentUrl.current) URL.revokeObjectURL(currentUrl.current); }, []);
  const draw = (marks: Point[]) => { const c = canvas.current, img = picture.current; if (!c || !img) return; const ctx = c.getContext('2d'); if (!ctx) return; ctx.drawImage(img, 0, 0, c.width, c.height); ctx.strokeStyle = '#00ffff'; ctx.fillStyle = '#00ffff'; ctx.lineWidth = 3; marks.forEach((p, i) => { ctx.beginPath(); ctx.arc(p.x, p.y, 7, 0, Math.PI * 2); ctx.fill(); if (i) { ctx.beginPath(); ctx.moveTo(marks[i - 1].x, marks[i - 1].y); ctx.lineTo(p.x, p.y); ctx.stroke(); } }); };
  const photo = async (file?: File) => { if (!file) return; setError(''); try { const next = URL.createObjectURL(file); if (currentUrl.current) URL.revokeObjectURL(currentUrl.current); currentUrl.current = next; const img = new window.Image(); img.src = next; await img.decode(); picture.current = img; setUrl(next); setPoints([]); setScale(0); setMeasured([]); requestAnimationFrame(() => { const c = canvas.current; if (!c) return; const ratio = Math.min(1, 1200 / Math.max(img.width, img.height)); c.width = Math.round(img.width * ratio); c.height = Math.round(img.height * ratio); draw([]); }); } catch { setError('无法读取这张照片，请重新选择'); } };
  const distance = () => points.length === 2 ? Math.hypot(points[1].x - points[0].x, points[1].y - points[0].y) : 0;
  const clear = () => { setPoints([]); draw([]); };
  return <View className='board-section'><Text className='board-section-title'>{!url ? '① 选择纸板照片' : !scale ? '② 标尺校准' : '③ 测量压线间距'}</Text><Text className='board-note'>纸板铺平，尺子放在同一平面，手机正对拍摄。手动点选两端测量，结果为估算，生产前用尺子核对。</Text>
    <input aria-label='选择纸板测量照片' type='file' accept='image/*' onChange={e => { void photo(e.target.files?.[0]); e.target.value = ''; }} />
    {url && <><canvas ref={canvas} aria-label='点击测量照片选取两个端点' style={{ width: '100%', height: 'auto', marginTop: 16, touchAction: 'manipulation' }} onClick={e => { const c = canvas.current; if (!c) return; const rect = c.getBoundingClientRect(); const point = { x: (e.clientX - rect.left) * c.width / rect.width, y: (e.clientY - rect.top) * c.height / rect.height }; const next = points.length === 2 ? [point] : [...points, point]; setPoints(next); draw(next); }} />
      <Text className='board-note'>{scale ? '已校准。依次点击两条压线上的对应点，或纸板边缘与压线。' : '点击照片中尺子已知长度的两个端点，然后校准。'} 已选 {points.length}/2 点。</Text>
      {!scale && <><BoardField label='参照长度' numeric value={reference} onChange={setReference} unit='cm' /><BoardButton disabled={points.length !== 2 || distance() < 2 || !Number.isFinite(Number(reference)) || Number(reference) <= 0} onClick={() => { setScale(Number(reference) / distance()); setMeasured([]); clear(); }}>用当前两点校准</BoardButton></>}
      <View className='board-actions'><BoardButton secondary disabled={!points.length} onClick={clear}>重选两点</BoardButton>{scale > 0 && <BoardButton secondary onClick={async () => { const answer = await Taro.showModal({ title: '重新校准？', content: '重新校准会清空当前测量记录。' }); if (answer.confirm) { setScale(0); setMeasured([]); clear(); } }}>重新校准</BoardButton>}</View>
      {scale > 0 && points.length === 2 && <><Text className='board-spec' style={{ display: 'block' }}>间距约 {(distance() * scale).toFixed(2)} cm</Text><BoardButton disabled={distance() < 2} onClick={() => { setMeasured(rows => [...rows, (distance() * scale).toFixed(2)]); clear(); }}>记录这段压线间距</BoardButton></>}
      {measured.length > 0 && <><Text className='board-section-title'>压线测量记录</Text>{measured.map((v, i) => <View key={i} className='board-detail-row'><Text>第 {i + 1} 段：约 {v} cm</Text><button aria-label={'删除第 ' + (i + 1) + ' 段'} onClick={() => setMeasured(rows => rows.filter((_, index) => index !== i))}>删除</button></View>)}<Text className='board-note'>合计约 {measured.reduce((sum, v) => sum + Number(v), 0).toFixed(2)} cm（仅连续分段测量时代表总长）</Text><BoardButton secondary onClick={() => Taro.setClipboardData({ data: '压线间距（照片估算）\n' + measured.map((v, i) => '第 ' + (i + 1) + ' 段：' + v + ' cm').join('\n') })}>复制测量记录</BoardButton></>}
    </>}{error && <Text>{error}</Text>}
  </View>;
}
