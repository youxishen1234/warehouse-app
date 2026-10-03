import { useEffect, useRef, useState } from 'react';
import Taro from '@tarojs/taro';
import ChatIcon from './icons';
import styles from './index.module.scss';

export interface ChatMessage {
  id: string; role: 'user' | 'assistant'; text: string; at: number;
  audio?: string; seconds?: number; images?: string[]; transcript?: string;
  state?: 'sending' | 'sent' | 'failed';
}
export default function Message({ item, onRetry, onError }: { item: ChatMessage; onRetry: () => void; onError: (message: string) => void }) {
  const player = useRef<HTMLAudioElement>(null);
  const [playing, setPlaying] = useState(false);
  const [transcriptOpen, setTranscriptOpen] = useState(false);
  const [duration, setDuration] = useState(item.seconds || 1);
  useEffect(() => { if (item.seconds) setDuration(item.seconds); }, [item.seconds]);
  useEffect(() => {
    const stop = () => { player.current?.pause(); setPlaying(false); };
    const hidden = () => { if (document.hidden) stop(); };
    window.addEventListener('warehouse-ai-audio', stop);
    document.addEventListener('visibilitychange', hidden);
    return () => { window.removeEventListener('warehouse-ai-audio', stop); document.removeEventListener('visibilitychange', hidden); };
  }, []);
  const play = async () => {
    if (playing) { player.current?.pause(); setPlaying(false); return; }
    window.dispatchEvent(new Event('warehouse-ai-audio'));
    try { await player.current?.play(); setPlaying(true); } catch { onError('当前设备无法播放这条语音'); }
  };
  return <div className={`${styles.message} ${item.role === 'user' ? styles.user : ''}`} data-chat-message={item.role} data-message-state={item.state || 'sent'}>
    <span className={`${styles.messageRole} ${item.role === 'user' ? styles.userAvatar : ''}`} aria-label={item.role === 'user' ? '我的头像' : '助手头像'}><ChatIcon name={item.role === 'user' ? 'person' : 'assistant'} /></span>
    <div className={styles.messageBody}>
      {item.audio && <>
        <button data-ai-control='button' className={`${styles.messageText} ${styles.voiceBubble} ${playing ? styles.playing : ''}`} aria-label={`播放语音 ${Math.max(1, Math.round(duration))} 秒`} aria-pressed={playing} onClick={() => void play()} style={{ width: `${Math.min(230, 90 + duration * 3)}px` }}>
          <span>{Math.max(1, Math.round(duration))}″</span><ChatIcon name='voice' />
        </button>
        <audio ref={player} src={item.audio} preload='metadata' onLoadedMetadata={event => { if (Number.isFinite(event.currentTarget.duration) && !item.seconds) setDuration(event.currentTarget.duration); }} onEnded={() => setPlaying(false)} onPause={() => setPlaying(false)} />
        {item.transcript && <button data-ai-control='button' className={styles.transcriptToggle} onClick={() => setTranscriptOpen(value => !value)}>{transcriptOpen ? '收起文字' : '转文字'}</button>}
        {transcriptOpen && <span className={styles.transcript}>{item.transcript}</span>}
      </>}
      {!!item.images?.length && <div className={styles.chatPhotos}>{item.images.map((src, index) => <button data-ai-control='button' key={index} className={styles.imageBubble} aria-label={`查看发送照片 ${index + 1}`} onClick={() => Taro.previewImage({ current: src, urls: item.images! })}><img src={src} alt={`发送照片 ${index + 1}`} /></button>)}</div>}
      {item.text && <span className={styles.messageText}>{item.text}</span>}
    </div>
    {item.state === 'sending' && <span className={styles.messagePending} role='status' aria-label='发送中' />}
    {item.state === 'failed' && <button data-ai-control='button' className={styles.messageFailed} aria-label='重新发送消息' onClick={onRetry}>!</button>}
  </div>;
}
