import { useEffect, useRef, useState } from 'react';
import { View, Text } from '@tarojs/components';
import Taro, { useDidHide } from '@tarojs/taro';
import jsQR from 'jsqr';
import { BoardPage, BoardButton, BoardField, BoardError } from '../../components/BoardUI';
import { getBoard, parseBoardCode } from '../../services/boards';
export default function BoardScan() {
  const video = useRef<HTMLVideoElement>(null); const stream = useRef<MediaStream | null>(null); const timer = useRef<ReturnType<typeof setTimeout> | null>(null); const generation = useRef(0); const opening = useRef(false);
  const [error, setError] = useState(''); const [active, setActive] = useState(false); const [code, setCode] = useState(''); const [busy, setBusy] = useState(false);
  const stop = () => { generation.current++; if (timer.current) clearTimeout(timer.current); stream.current?.getTracks().forEach(t => t.stop()); stream.current = null; if (video.current) video.current.srcObject = null; setActive(false); };
  useEffect(() => () => { generation.current++; if (timer.current) clearTimeout(timer.current); stream.current?.getTracks().forEach(t => t.stop()); }, []);
  useDidHide(stop);
  const open = async (raw: string) => { if (opening.current) return; opening.current = true; stop(); setBusy(true); setError(''); try { const id = parseBoardCode(raw); await getBoard(id); await Taro.redirectTo({ url: '/pages/board-detail/index?id=' + id }); } catch (e) { setError(e.message); } finally { opening.current = false; setBusy(false); } };
  const start = async () => {
    stop(); const current = generation.current; setError('');
    try {
      if (!navigator.mediaDevices?.getUserMedia) throw new Error('当前环境无法打开相机，请使用下方照片识别或输入批次号。');
      const media = await navigator.mediaDevices.getUserMedia({ video: { facingMode: { ideal: 'environment' } }, audio: false });
      if (current !== generation.current) { media.getTracks().forEach(t => t.stop()); return; }
      stream.current = media; if (!video.current) { stop(); return; } video.current.srcObject = media; await video.current.play(); setActive(true);
      const canvas = document.createElement('canvas'); const ctx = canvas.getContext('2d', { willReadFrequently: true });
      const tick = () => { if (current !== generation.current) return; const v = video.current; if (v && v.readyState >= 2 && ctx) { canvas.width = 640; canvas.height = Math.round(640 * v.videoHeight / v.videoWidth); ctx.drawImage(v, 0, 0, canvas.width, canvas.height); const pixels = ctx.getImageData(0, 0, canvas.width, canvas.height); const found = jsQR(pixels.data, pixels.width, pixels.height, { inversionAttempts: 'dontInvert' }); if (found) { void open(found.data); return; } } timer.current = setTimeout(tick, 180); }; tick();
    } catch (e) { stop(); setError(e.name === 'NotAllowedError' ? '相机权限未开启。请在系统设置中允许相机，或从照片识别标签。' : e.message || '相机启动失败，请重试或识别照片'); }
  };
  const photo = async (file?: File) => {
    if (!file) return; stop(); setError(''); const url = URL.createObjectURL(file);
    try { const img = new window.Image(); img.src = url; await img.decode(); const canvas = document.createElement('canvas'); const ratio = Math.min(1, 1600 / Math.max(img.width, img.height)); canvas.width = Math.round(img.width * ratio); canvas.height = Math.round(img.height * ratio); const ctx = canvas.getContext('2d'); if (!ctx) throw new Error('无法读取照片'); ctx.drawImage(img, 0, 0, canvas.width, canvas.height); const p = ctx.getImageData(0, 0, canvas.width, canvas.height); const result = jsQR(p.data, p.width, p.height); if (!result) throw new Error('没有识别到二维码，请选择清晰、完整的标签照片'); await open(result.data); } catch (e) { setError(e.message); } finally { URL.revokeObjectURL(url); }
  };
  return <BoardPage title='扫码找纸板' subtitle='对准批次标签，查看实时库存和来料规格。'><video ref={video} className='board-camera' playsInline muted aria-label='扫码相机画面' /><View className='board-actions'><BoardButton disabled={busy} onClick={active ? stop : start}>{active ? '关闭相机' : '打开相机扫码'}</BoardButton></View>{error && <BoardError message={error} />}<View className='board-section'><Text className='board-section-title'>也可以识别标签照片</Text><input aria-label='选择二维码照片' className='board-file' type='file' accept='image/*' onChange={e => { void photo(e.target.files?.[0]); e.target.value = ''; }} /><Text className='board-note'>相机不可用时，选择拍好的标签照片即可。</Text></View><View className='board-section'><BoardField label='批次号或标签链接' value={code} onChange={setCode} placeholder='BOARD-…' /><BoardButton secondary disabled={busy || !code.trim()} onClick={() => open(code)}>查找这批纸板</BoardButton></View></BoardPage>;
}
