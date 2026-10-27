/* eslint-disable react/forbid-elements */
import { useCallback, useEffect, useRef, useState } from 'react';
import { cleanPrintPairFromAddress, getRemoteDevice, getRemotePrintJob, newRemotePrintId, parsePrintPairToken, readPrintAttempt, readPrintPair, readPrintPairFromAddress, resolveRemotePrintJob, savePrintAttempt, savePrintPair, submitRemotePrint } from '@/services/remote-print';
import type { RemoteDevice, RemoteJob } from '@/services/remote-print';
import { scanPrintPairQr } from '@/services/print-pair-scan';
import type { SavedPrintNote } from '@/services/print-notes';
import { refreshPrintNotices, reportPrintNoticeError, trackPrintNotice, updatePrintNotice } from '@/services/print-notifications';
import { useMobilePrintNotifications } from '@/services/mobile-print-notifications';
import { readBluetooth630KPending, readRemotePrintPending } from '@/services/print-transport-pending';
import styles from './index.module.scss';

const messageOf = (issue: unknown) => issue instanceof Error ? issue.message : '打印连接失败，请刷新状态重试';
const terminalStatuses = new Set(['queued', 'failed', 'expired']);
const pendingStatuses = new Set(['waiting', 'processing', 'uncertain']);

export type RemotePrintController = {
  token: string;
  saved?: SavedPrintNote;
  device?: RemoteDevice;
  deviceError: string;
  job?: RemoteJob;
  jobError: string;
  message: string;
  busy: boolean;
  checking: boolean;
  canSend: boolean;
  resolving: string;
  confirmCopy: boolean;
  setConfirmCopy: (value: boolean) => void;
  progress: string;
  deviceStatus: string;
  terminal: boolean;
  pending: boolean;
  // The id this screen submitted, so a caller can tell a job it started from
  // an older one it merely opened.
  lastSentId: string;
  pair: (value?: string) => Promise<void>;
  send: (newCopy?: boolean) => Promise<void>;
  resolve: (outcome: 'printed' | 'missing') => Promise<void>;
  requestRefresh: () => void;
  disconnect: () => void;
};

export function useRemotePrint(saved: SavedPrintNote | undefined, paper: string, enabled = true): RemotePrintController {
  const mobileNotices = useMobilePrintNotifications();
  const [linkedPair] = useState(readPrintPairFromAddress);
  const [hadPairLink] = useState(() => typeof window !== 'undefined' && window.location.href.includes('print_pair='));
  const linkHandled = useRef(false);
  const [token, setToken] = useState(readPrintPair);
  const [device, setDevice] = useState<RemoteDevice>();
  const [deviceError, setDeviceError] = useState('');
  const [job, setJob] = useState<RemoteJob>();
  const [jobError, setJobError] = useState('');
  const [message, setMessage] = useState('');
  const [busy, setBusy] = useState(false);
  const [checking, setChecking] = useState(false);
  const [confirmCopy, setConfirmCopy] = useState(false);
  const [attemptId, setAttemptId] = useState('');
  const [attemptScope, setAttemptScope] = useState('');
  const [lastSentId, setLastSentId] = useState('');
  const [resolving, setResolving] = useState('');
  const [refresh, setRefresh] = useState(0);
  const [now, setNow] = useState(Date.now);
  const sending = useRef(false);
  const fingerprint = saved && device ? JSON.stringify({ device: device.id, id: saved.id, version: saved.version, paper }) : '';
  const currentScope = useRef('');
  currentScope.current = token + fingerprint;
  const globalPending = readRemotePrintPending();
  const globalPendingId = globalPending?.id || '';
  const foreignPending = !!globalPending && globalPending.noteId !== saved?.id;
  const bluetoothPending = readBluetooth630KPending();

  useEffect(() => {
    const id = globalPendingId || (fingerprint ? readPrintAttempt(fingerprint) : '');
    const scope = token + fingerprint;
    setJob(previous => previous?.id === id ? previous : undefined); setJobError(''); setMessage(''); setConfirmCopy(false);
    setAttemptId(id); setAttemptScope(scope);
    if (id !== attemptId || attemptScope !== scope) setChecking(!!id);
  }, [fingerprint, token, globalPendingId, attemptId, attemptScope]);
  useEffect(() => { setLastSentId(''); }, [fingerprint, token]);

  const recoveredId = !foreignPending && fingerprint ? readPrintAttempt(fingerprint) : '';
  useEffect(() => {
    if (!mobileNotices || !recoveredId || !saved || !device) return;
    trackPrintNotice({ id: recoveredId, noteId: saved.id, noteNumber: saved.number, printer: device.printer, deviceId: device.id, createdAt: Date.now() });
  }, [mobileNotices, recoveredId, saved, device]);

  useEffect(() => {
    if (!enabled || !token) return;
    let active = true;
    let timer: ReturnType<typeof setTimeout>;
    const poll = async () => {
      if (mobileNotices && document.visibilityState === 'hidden') return;
      try {
        const result = await getRemoteDevice(token);
        if (active) { setDevice(result); setDeviceError(''); setNow(Date.now()); }
      } catch (issue) { if (active) setDeviceError(messageOf(issue)); }
      finally { if (active && (!mobileNotices || document.visibilityState !== 'hidden')) timer = setTimeout(() => void poll(), 5000); }
    };
    void poll();
    return () => { active = false; clearTimeout(timer); };
  }, [enabled, token, refresh, mobileNotices]);

  useEffect(() => {
    if (!enabled || !attemptId || busy || resolving || !token) return;
    let active = true;
    let timer: ReturnType<typeof setTimeout>;
    const poll = async () => {
      if (mobileNotices && document.visibilityState === 'hidden') return;
      let complete = false;
      try {
        const result = await getRemotePrintJob(attemptId, token);
        if (active) {
          setJob(result); setJobError(''); setMessage(''); setNow(Date.now());
          if (mobileNotices && readPrintPair() === token) updatePrintNotice(result);
        }
        complete = terminalStatuses.has(result.status);
      } catch (issue) {
        if (active) {
          const error = (issue as { statusCode?: number })?.statusCode === 404
            ? '服务器尚未收到该任务，可点发送重试，将沿用原任务编号'
            : messageOf(issue);
          setJobError(error);
          if (mobileNotices && readPrintPair() === token) reportPrintNoticeError(attemptId, error);
        }
      } finally {
        if (active) { setChecking(false); if (!complete && (!mobileNotices || document.visibilityState !== 'hidden')) timer = setTimeout(() => void poll(), 2000); }
      }
    };
    void poll();
    return () => { active = false; clearTimeout(timer); };
  }, [enabled, attemptId, busy, resolving, token, fingerprint, refresh, mobileNotices]);

  useEffect(() => {
    const resume = () => { if (document.visibilityState !== 'hidden') setRefresh(value => value + 1); };
    window.addEventListener('online', resume); window.addEventListener('focus', resume);
    document.addEventListener('visibilitychange', resume);
    return () => { window.removeEventListener('online', resume); window.removeEventListener('focus', resume); document.removeEventListener('visibilitychange', resume); };
  }, []);

  const pair = useCallback(async (raw?: string) => {
    if (sending.current) return;
    sending.current = true; setBusy(true); setMessage('');
    try {
      const scanned = raw === undefined ? await scanPrintPairQr() : raw;
      if (!scanned) return;
      const candidate = parsePrintPairToken(scanned);
      if (!candidate) throw new Error('没有识别到有效的打印连接二维码，请重新扫码或打开连接链接');
      const result = await getRemoteDevice(candidate);
      cleanPrintPairFromAddress();
      savePrintPair(candidate); setDevice(result); setDeviceError(''); setToken(candidate);
      if (mobileNotices) void refreshPrintNotices();
    } catch (issue) { setMessage(messageOf(issue)); }
    finally { sending.current = false; setBusy(false); }
  }, [mobileNotices]);

  useEffect(() => {
    if (!enabled || linkHandled.current) return;
    linkHandled.current = true;
    if (linkedPair) void pair(linkedPair);
    else if (hadPairLink) setMessage('打印连接链接无效，请重新扫描电脑上的二维码');
  }, [enabled, hadPairLink, linkedPair, pair]);

  const send = async (newCopy = false) => {
    if (!saved || !canSend || sending.current) return;
    const scope = currentScope.current;
    let noticeId = '';
    sending.current = true; setBusy(true); setMessage(''); setJobError(''); setConfirmCopy(false);
    try {
      const id = newCopy ? newRemotePrintId() : attemptId || readPrintAttempt(fingerprint) || newRemotePrintId();
      // Save before sending so a lost response or closing the preview is safe.
      savePrintAttempt(fingerprint, id); setAttemptId(id); setLastSentId(id);
      noticeId = id;
      if (mobileNotices && device) {
        trackPrintNotice({ id, noteId: saved.id, noteNumber: saved.number, printer: device.printer, deviceId: device.id, createdAt: Date.now() });
      }
      if (newCopy) setJob(undefined);
      const result = await submitRemotePrint({ id, note_id: saved.id, version: saved.version, paper }, token);
      if (mobileNotices && readPrintPair() === token) updatePrintNotice(result);
      if (currentScope.current === scope) { setJob(result); setNow(Date.now()); }
    } catch (issue) {
      if (mobileNotices && noticeId && readPrintPair() === token) reportPrintNoticeError(noticeId, messageOf(issue));
      if (currentScope.current === scope) setMessage(messageOf(issue));
    }
    finally { sending.current = false; setBusy(false); }
  };

  const resolve = async (outcome: 'printed' | 'missing') => {
    if (!job || sending.current || resolving) return;
    const scope = currentScope.current;
    sending.current = true; setResolving(outcome); setMessage(''); setJobError('');
    try {
      const result = await resolveRemotePrintJob(job.id, outcome, token);
      if (mobileNotices && readPrintPair() === token) updatePrintNotice(result);
      if (currentScope.current === scope) { setJob(result); setNow(Date.now()); }
    } catch (issue) { if (currentScope.current === scope) setMessage(messageOf(issue)); }
    finally { sending.current = false; setResolving(''); }
  };

  const disconnect = () => {
    try {
      savePrintPair(''); setToken(''); setDevice(undefined); setDeviceError('');
      if (mobileNotices) void refreshPrintNotices();
    } catch (issue) { setMessage(messageOf(issue)); }
  };

  const terminal = !!job && terminalStatuses.has(job.status);
  const pending = !!job && pendingStatuses.has(job.status);
  const canSend = enabled && !bluetoothPending && !foreignPending && !!fingerprint && attemptScope === currentScope.current && !busy && !checking && !resolving && !pending && !deviceError;
  const deviceStatus = !token ? '未连接打印电脑' : deviceError ? '连接状态未确认' : !device ? '正在连接电脑' : !device.online ? '电脑离线' : job?.status === 'processing' ? '电脑正在打印' : !device.ready ? '打印机不可用' : '电脑在线';
  let progress = job?.message || '';
  if (job?.status === 'waiting') {
    if (deviceError) progress = '任务已提交，暂时无法查询电脑状态，正在自动重试。请勿重复发送。';
    else if (!device?.online) progress = '任务已提交，但打印电脑离线。电脑开机并登录后自动接收，不必重复发送。';
    else if (!device.ready) progress = '任务已提交，打印机暂不可用。请检查打印机电源、USB连接和缺纸情况，恢复后自动接收。';
    else if (job.created_at && now - job.created_at > 15000) progress = '任务已提交，电脑尚未接收。正在自动查询，请检查电脑接收程序，勿重复发送。';
  }
  if (job?.status === 'uncertain') progress = '打印结果尚未确认，已暂停重复发送。请核对电脑打印队列和实际出纸；状态会自动更新。';

  return {
    token, saved, device, deviceError, job, jobError, message, busy, checking, canSend, resolving,
    confirmCopy, setConfirmCopy, progress, deviceStatus, terminal, pending, lastSentId,
    pair, send, resolve, requestRefresh: () => setRefresh(value => value + 1), disconnect
  };
}

// The panel is presentation only: the preview owns the same controller so its
// primary button can send without expanding this section first.
export default function RemotePrint({ remote, open, onOpenChange, showSendAction = true }: {
  remote: RemotePrintController;
  open?: boolean;
  onOpenChange?: (open: boolean) => void;
  showSendAction?: boolean;
}) {
  const { token, device, deviceError, job, jobError, message, busy, checking, resolving, confirmCopy, setConfirmCopy, progress, deviceStatus, terminal, pending } = remote;
  return <details className={styles.settings} open={open} onToggle={event => onOpenChange?.(event.currentTarget.open)}>
    <summary>远程打印到店里 · {deviceStatus}</summary>
    <div className={styles.settingsBody}>
      {!token ? <>
        <p className={styles.muted}>扫描店里打印电脑上的连接二维码，即可完成连接；也可直接打开电脑提供的连接链接。</p>
        <button type='button' className={styles.secondary} disabled={busy} onClick={() => void remote.pair()}>{busy ? '正在验证连接…' : '扫描连接二维码'}</button>
      </> : <>
        <p className={styles.muted}>{device?.name || '打印电脑'} · {device?.printer || '630K'}<br />电脑需开机、登录并联网，打印机需开机。仅发送打印，不自动出库。</p>
        {!remote.saved && <p className={styles.muted}>请先保存单据，再发送远程打印。</p>}
        {device && !deviceError && !device.online && !pending && <p className={styles.muted}>打印电脑离线；可以先发送，电脑恢复在线后自动接收。</p>}
        <div className={styles.previewControls}>
          {showSendAction && <button type='button' className={styles.primary} disabled={!remote.canSend} onClick={() => terminal ? setConfirmCopy(true) : void remote.send()}>{busy ? '正在发送…' : checking ? '正在查询上次打印…' : terminal ? '再打印一份' : pending ? '任务处理中…' : '发送到630K'}</button>}
          <button type='button' className={styles.secondary} disabled={busy} onClick={remote.requestRefresh}>刷新打印状态</button>
        </div>
        {confirmCopy && <div role='group' aria-label='确认重新打印'><p className={styles.muted}>请先检查电脑队列和实际出纸，确认后会新建任务再打印一份。</p><button type='button' className={styles.secondary} onClick={() => setConfirmCopy(false)}>取消</button><button type='button' className={styles.primary} disabled={busy} onClick={() => void remote.send(true)}>确认再打印一份</button></div>}
        {job?.status === 'uncertain' && <div role='group' aria-label='核对实际出纸'>
          <p className={styles.muted}>请到打印机前确认这张单子是否已经出来。在核对之前，这台电脑不会接收新的打印任务。</p>
          <button type='button' className={styles.primary} disabled={!!resolving} onClick={() => void remote.resolve('printed')}>{resolving === 'printed' ? '正在确认…' : '已经出纸了'}</button>
          <button type='button' className={styles.secondary} disabled={!!resolving} onClick={() => void remote.resolve('missing')}>{resolving === 'missing' ? '正在确认…' : '没有出纸'}</button>
        </div>}
        {!showSendAction && job?.status === 'queued' && !job.confirmed_printed_at && !/人工核对|人工确认/.test(job.message) && <button type='button' className={styles.secondary} disabled={!!resolving} onClick={() => void remote.resolve('printed')}>{resolving === 'printed' ? '正在确认…' : '已经出纸了'}</button>}
        <button type='button' className={styles.textButton} disabled={busy} onClick={remote.disconnect}>更换打印电脑</button>
      </>}
      {job && <p role='status' aria-live='polite' className={styles.notice}>{progress}</p>}
      {deviceError && <p role='alert' className={styles.error}>{deviceError}</p>}
      {jobError && <p role='alert' className={styles.error}>{jobError}</p>}
      {message && <p role='alert' className={styles.error}>{message}</p>}
      {readBluetooth630KPending() && <p role='alert' className={styles.error}>蓝牙原任务尚未确认，请切回蓝牙查询原任务，网络打印暂不发送新任务。</p>}
      {readRemotePrintPending() && readRemotePrintPending()?.noteId !== remote.saved?.id && <p role='alert' className={styles.error}>正在查询其他单据的原打印任务，核对完成前不发送新的打印任务。</p>}
    </div>
  </details>;
}
