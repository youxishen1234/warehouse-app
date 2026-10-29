import { useEffect, useRef, useState } from 'react';
import { readAiAudio } from '@/services/ai';
import ChatIcon from './icons';
import styles from './index.module.scss';

interface Props {
  disabled: boolean; available: boolean;
  onSend: (audio: string, seconds: number) => void;
  onRecording: (active: boolean) => void; onError: (message: string) => void;
}
type Phase = 'idle' | 'requesting' | 'recording' | 'stopping';
export default function VoiceInput({ disabled, available, onSend, onRecording, onError }: Props) {
  const [phase, setPhase] = useState<Phase>('idle');
  const [seconds, setSeconds] = useState(0);
  const [sliding, setSliding] = useState(false);
  const phaseRef = useRef<Phase>('idle');
  const gesture = useRef<{ pointer: number; y: number; cancel: boolean }>();
  const generation = useRef(0);
  const mounted = useRef(true);
  const cancel = useRef<() => void>(() => {});
  const finish = useRef<() => void>(() => {});
  const callbacks = useRef({ onSend, onRecording, onError });
  callbacks.current = { onSend, onRecording, onError };
  const changePhase = (value: Phase) => { phaseRef.current = value; if (mounted.current) setPhase(value); };
  const cancelGesture = () => { gesture.current = undefined; if (mounted.current) setSliding(false); cancel.current(); };
  useEffect(() => {
    mounted.current = true;
    const hidden = () => { if (document.hidden) cancelGesture(); };
    const blurred = () => cancelGesture();
    document.addEventListener('visibilitychange', hidden);
    window.addEventListener('pagehide', blurred);
    window.addEventListener('blur', blurred);
    return () => {
      mounted.current = false; cancel.current(); generation.current += 1;
      document.removeEventListener('visibilitychange', hidden);
      window.removeEventListener('pagehide', blurred); window.removeEventListener('blur', blurred);
      callbacks.current.onRecording(false);
    };
  }, []);
  const start = async () => {
    if (disabled || !available || phaseRef.current !== 'idle') return;
    const bridge = (window as any).Capacitor;
    if (bridge?.isNativePlatform?.() && bridge?.getPlatform?.() === 'ios' && !(window as any).__sgNativeDock?.microphone) {
      gesture.current = undefined;
      onError('当前安装包没有麦克风权限，需要安装支持录音的新版 App；也可在手机浏览器按住说话'); return;
    }
    if (!navigator.mediaDevices?.getUserMedia || typeof MediaRecorder === 'undefined') {
      gesture.current = undefined; onError('当前设备不能直接录音，请在手机 HTTPS 浏览器打开，或从“＋”选择语音文件'); return;
    }
    const id = ++generation.current;
    changePhase('requesting'); setSeconds(0); onRecording(true); onError('');
    let stream: MediaStream | undefined;
    let recorder: MediaRecorder | undefined;
    let timer: ReturnType<typeof setInterval> | undefined;
    let limitTimer: ReturnType<typeof setTimeout> | undefined;
    let cancelled = false;
    let started = 0;
    let duration = 0;
    const current = () => mounted.current && generation.current === id;
    const release = () => { clearInterval(timer); clearTimeout(limitTimer); stream?.getTracks().forEach(track => track.stop()); };
    const idle = () => { if (current()) { changePhase('idle'); setSliding(false); callbacks.current.onRecording(false); } };
    cancel.current = () => {
      cancelled = true; gesture.current = undefined;
      if (recorder?.state === 'recording') recorder.stop();
      release(); idle();
    };
    finish.current = () => {};
    try {
      stream = await navigator.mediaDevices.getUserMedia({ audio: { echoCancellation: true, noiseSuppression: true }, video: false });
      if (cancelled || !current()) { release(); return; }
      const mimeType = ['audio/webm;codecs=opus', 'audio/mp4', 'audio/ogg;codecs=opus', 'audio/webm'].find(type => MediaRecorder.isTypeSupported(type));
      recorder = new MediaRecorder(stream, { ...(mimeType ? { mimeType } : {}), audioBitsPerSecond: 64000 });
      const chunks: Blob[] = [];
      let bytes = 0;
      recorder.ondataavailable = event => {
        if (cancelled || !current()) return;
        if (event.data.size) { chunks.push(event.data); bytes += event.data.size; }
        if (bytes > 6 * 1024 * 1024) { cancel.current(); if (current()) callbacks.current.onError('录音过大，请录短一些'); }
      };
      recorder.onerror = () => { if (current()) { cancel.current(); callbacks.current.onError('录音中断，请重新按住说话'); } };
      recorder.onstop = async () => {
        release();
        if (cancelled || !current()) return;
        changePhase('stopping');
        try {
          const data = await readAiAudio(new Blob(chunks, { type: recorder?.mimeType || mimeType || 'audio/webm' }));
          if (!cancelled && current()) { idle(); callbacks.current.onSend(data, duration); }
        } catch (error) { if (current()) callbacks.current.onError(error instanceof Error ? error.message : '无法保存录音'); }
        finally { idle(); }
      };
      finish.current = () => {
        if (recorder?.state !== 'recording') return;
        duration = Math.min(60, (Date.now() - started) / 1000);
        if (duration < .5) { cancel.current(); callbacks.current.onError('说话时间太短，请按住再说一次'); }
        else { changePhase('stopping'); recorder.stop(); }
      };
      recorder.start(500); started = Date.now(); changePhase('recording');
      timer = setInterval(() => { if (current()) setSeconds(Math.min(60, Math.floor((Date.now() - started) / 1000))); }, 250);
      limitTimer = setTimeout(() => {
        const discard = gesture.current?.cancel; gesture.current = undefined;
        if (discard) cancel.current(); else finish.current();
      }, 60000);
    } catch (error) {
      release();
      if (current() && !cancelled) callbacks.current.onError((error as { name?: string })?.name === 'NotAllowedError'
        ? '未获得麦克风权限，请在系统设置中允许录音'
        : '当前设备无法录音，请稍后重试，或从“＋”选择语音文件');
      gesture.current = undefined; idle();
    }
  };
  return <div className={styles.voicePanel}>
    <button data-ai-control='button' className={`${styles.holdToTalk} ${phase === 'recording' ? styles.recording : ''}`}
      aria-label='按住说话' aria-pressed={phase === 'recording'} disabled={disabled || !available || phase === 'stopping'}
      onContextMenu={event => event.preventDefault()}
      onPointerDown={event => {
        if (event.button !== 0 || phaseRef.current !== 'idle' || gesture.current) return;
        event.preventDefault(); event.currentTarget.setPointerCapture(event.pointerId);
        gesture.current = { pointer: event.pointerId, y: event.clientY, cancel: false }; setSliding(false); void start();
      }}
      onPointerMove={event => {
        const held = gesture.current; if (!held || held.pointer !== event.pointerId) return;
        held.cancel = held.y - event.clientY > 60; setSliding(held.cancel);
      }}
      onPointerUp={event => {
        const held = gesture.current; if (!held || held.pointer !== event.pointerId) return;
        gesture.current = undefined; setSliding(false);
        if (held.cancel || phaseRef.current === 'requesting') cancel.current(); else finish.current();
      }}
      onPointerCancel={cancelGesture}
      onLostPointerCapture={() => { if (gesture.current) cancelGesture(); }}
      onKeyDown={event => { if ((event.key === ' ' || event.key === 'Enter') && !event.repeat && phaseRef.current === 'idle') { event.preventDefault(); void start(); } }}
      onKeyUp={event => { if (event.key === ' ' || event.key === 'Enter') { event.preventDefault(); if (phaseRef.current === 'requesting') cancel.current(); else finish.current(); } }}>
      {phase === 'requesting' ? '请允许麦克风' : phase === 'stopping' ? '正在准备…' : phase === 'recording' ? '松开 结束' : '按住 说话'}
    </button>
    {(phase === 'recording' || phase === 'requesting') && <div className={styles.voiceShade}>
      <div className={`${styles.voiceOverlay} ${sliding ? styles.cancelVoice : ''}`} role='status'>
        <div className={styles.voiceVisual}>{sliding ? <ChatIcon name='close' /> : <><ChatIcon name='mic' /><div className={styles.voiceWave}>{[1, 2, 3, 4, 5, 6, 7].map(bar => <i key={bar} style={{ animationDelay: `${bar * -.15}s` }} />)}</div></>}</div>
        <span className={styles.voiceTimer}>{phase === 'requesting' ? '正在请求麦克风权限' : `正在录音 · ${seconds} 秒`}</span>
        <span className={styles.voiceInstruction}>{sliding ? '松开手指，取消发送' : seconds >= 50 ? `还可说 ${60 - seconds} 秒` : '手指上滑，取消发送'}</span>
      </div>
    </div>}
  </div>;
}
