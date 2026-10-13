/* eslint-disable react/forbid-elements */
import { useEffect, useRef, useState } from 'react';
import { getRemoteDevice, getRemotePrintJob, newRemotePrintId, readPrintAttempt, readPrintPair, resolveRemotePrintJob, savePrintAttempt, savePrintPair, submitRemotePrint } from '@/services/remote-print';
import type { RemoteDevice, RemoteJob } from '@/services/remote-print';
import type { SavedPrintNote } from '@/services/print-notes';
import styles from './index.module.scss';

const messageOf = (issue: unknown) => issue instanceof Error ? issue.message : '打印连接失败，请刷新状态重试';

export default function RemotePrint({ saved, paper }: { saved?: SavedPrintNote; paper: string }) {
  const [code, setCode] = useState(() => new URLSearchParams(location.hash.split('?')[1] || '').get('print_pair') || '');
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
  const [resolving, setResolving] = useState('');
  const [refresh, setRefresh] = useState(0);
  const [now, setNow] = useState(Date.now);
  const sending = useRef(false);
  const fingerprint = saved && device ? JSON.stringify({ device: device.id, id: saved.id, version: saved.version, paper }) : '';
  const currentScope = useRef('');
  currentScope.current = token + fingerprint;

  useEffect(() => {
    setJob(undefined); setJobError(''); setMessage(''); setConfirmCopy(false);
    const id = fingerprint ? readPrintAttempt(fingerprint) : '';
    setAttemptId(id); setChecking(!!id);
  }, [fingerprint, token]);

  useEffect(() => {
    if (!token) return;
    let active = true;
    let timer: ReturnType<typeof setTimeout>;
    const poll = async () => {
      try {
        const result = await getRemoteDevice(token);
        if (active) { setDevice(result); setDeviceError(''); setNow(Date.now()); }
      } catch (issue) { if (active) setDeviceError(messageOf(issue)); }
      finally { if (active) timer = setTimeout(() => void poll(), 5000); }
    };
    void poll();
    return () => { active = false; clearTimeout(timer); };
  }, [token, refresh]);

  useEffect(() => {
    if (!attemptId || busy || !token) return;
    let active = true;
    let timer: ReturnType<typeof setTimeout>;
    const poll = async () => {
      let complete = false;
      try {
        const result = await getRemotePrintJob(attemptId, token);
        if (active) { setJob(result); setJobError(''); setMessage(''); setNow(Date.now()); }
        complete = ['queued', 'failed', 'expired'].includes(result.status);
      } catch (issue) {
        if (active) setJobError((issue as { statusCode?: number })?.statusCode === 404
          ? '服务器尚未收到该任务，可点发送重试，将沿用原任务编号'
          : messageOf(issue));
      } finally {
        if (active) { setChecking(false); if (!complete) timer = setTimeout(() => void poll(), 2000); }
      }
    };
    void poll();
    return () => { active = false; clearTimeout(timer); };
  }, [attemptId, busy, token, fingerprint, refresh]);

  useEffect(() => {
    const resume = () => { if (document.visibilityState !== 'hidden') setRefresh(value => value + 1); };
    window.addEventListener('online', resume); window.addEventListener('focus', resume);
    document.addEventListener('visibilitychange', resume);
    return () => { window.removeEventListener('online', resume); window.removeEventListener('focus', resume); document.removeEventListener('visibilitychange', resume); };
  }, []);

  const pair = async () => {
    if (sending.current) return;
    sending.current = true; setBusy(true); setMessage('');
    try {
      const candidate = code.trim();
      if (!/^[a-f0-9]{64}$/.test(candidate)) throw new Error('请粘贴电脑提供的完整配对码');
      const result = await getRemoteDevice(candidate);
      savePrintPair(candidate); setDevice(result); setDeviceError(''); setToken(candidate); setCode('');
    } catch (issue) { setMessage(messageOf(issue)); }
    finally { sending.current = false; setBusy(false); }
  };

  const send = async (newCopy = false) => {
    if (!saved || !fingerprint || sending.current) return;
    const scope = currentScope.current;
    sending.current = true; setBusy(true); setMessage(''); setJobError(''); setConfirmCopy(false);
    try {
      const id = newCopy ? newRemotePrintId() : attemptId || readPrintAttempt(fingerprint) || newRemotePrintId();
      // Save before sending so a lost response or closing the preview is safe.
      savePrintAttempt(fingerprint, id); setAttemptId(id);
      if (newCopy) setJob(undefined);
      const result = await submitRemotePrint({ id, note_id: saved.id, version: saved.version, paper }, token);
      if (currentScope.current === scope) { setJob(result); setNow(Date.now()); }
    } catch (issue) { if (currentScope.current === scope) setMessage(messageOf(issue)); }
    finally { sending.current = false; setBusy(false); }
  };

  const resolve = async (outcome: 'printed' | 'missing') => {
    if (!job || sending.current || resolving) return;
    const scope = currentScope.current;
    sending.current = true; setResolving(outcome); setMessage(''); setJobError('');
    try {
      const result = await resolveRemotePrintJob(job.id, outcome, token);
      if (currentScope.current === scope) { setJob(result); setNow(Date.now()); }
    } catch (issue) { if (currentScope.current === scope) setMessage(messageOf(issue)); }
    finally { sending.current = false; setResolving(''); }
  };

  const terminal = job && ['queued', 'failed', 'expired'].includes(job.status);
  const pending = job && ['waiting', 'processing', 'uncertain'].includes(job.status);
  const deviceStatus = !token ? '未连接打印电脑' : deviceError ? '连接状态未确认' : !device ? '正在连接电脑' : !device.online ? '电脑离线' : job?.status === 'processing' ? '电脑正在打印' : !device.ready ? '打印机不可用' : '电脑在线';
  let progress = job?.message || '';
  if (job?.status === 'waiting') {
    if (deviceError) progress = '任务已提交，暂时无法查询电脑状态，正在自动重试。请勿重复发送。';
    else if (!device?.online) progress = '任务已提交，但打印电脑离线。电脑开机并登录后自动接收，不必重复发送。';
    else if (!device.ready) progress = '任务已提交，打印机暂不可用。请检查打印机电源、USB连接和缺纸情况，恢复后自动接收。';
    else if (job.created_at && now - job.created_at > 15000) progress = '任务已提交，电脑尚未接收。正在自动查询，请检查电脑接收程序，勿重复发送。';
  }
  if (job?.status === 'uncertain') progress = '打印结果尚未确认，已暂停重复发送。请核对电脑打印队列和实际出纸；状态会自动更新。';

  return <details className={styles.settings}>
    <summary>远程打印到店里 · {deviceStatus}</summary>
    <div className={styles.settingsBody}>
      {!token ? <>
        <p className={styles.muted}>粘贴打印电脑提供的配对码，即可用手机发送送货单。</p>
        <input aria-label='打印电脑配对码' type='search' value={code} onChange={event => setCode(event.target.value)} placeholder='粘贴配对码' />
        <button type='button' className={styles.secondary} disabled={busy} onClick={() => void pair()}>{busy ? '正在连接…' : '连接打印电脑'}</button>
      </> : <>
        <p className={styles.muted}>{device?.name || '打印电脑'} · {device?.printer || '630K'}<br />电脑需开机、登录并联网，打印机需开机。仅发送打印，不自动出库。</p>
        {!saved && <p className={styles.muted}>请先保存单据，再发送远程打印。</p>}
        {device && !deviceError && !device.online && !pending && <p className={styles.muted}>打印电脑离线；可以先发送，电脑恢复在线后自动接收。</p>}
        <div className={styles.previewControls}>
          <button type='button' className={styles.primary} disabled={busy || checking || !saved || !device || !!pending} onClick={() => terminal ? setConfirmCopy(true) : void send()}>{busy ? '正在发送…' : checking ? '正在查询上次打印…' : terminal ? '再打印一份' : pending ? '任务处理中…' : '发送到630K'}</button>
          <button type='button' className={styles.secondary} disabled={busy} onClick={() => setRefresh(value => value + 1)}>刷新打印状态</button>
        </div>
        {confirmCopy && <div role='group' aria-label='确认重新打印'><p className={styles.muted}>请先检查电脑队列和实际出纸，确认后会新建任务再打印一份。</p><button type='button' className={styles.secondary} onClick={() => setConfirmCopy(false)}>取消</button><button type='button' className={styles.primary} disabled={busy} onClick={() => void send(true)}>确认再打印一份</button></div>}
        {job?.status === 'uncertain' && <div role='group' aria-label='核对实际出纸'>
          <p className={styles.muted}>请到打印机前确认这张单子是否已经出来。在核对之前，这台电脑不会接收新的打印任务。</p>
          <button type='button' className={styles.primary} disabled={!!resolving} onClick={() => void resolve('printed')}>{resolving === 'printed' ? '正在确认…' : '已经出纸了'}</button>
          <button type='button' className={styles.secondary} disabled={!!resolving} onClick={() => void resolve('missing')}>{resolving === 'missing' ? '正在确认…' : '没有出纸'}</button>
        </div>}
        <button type='button' className={styles.textButton} disabled={busy} onClick={() => { savePrintPair(''); setToken(''); setDevice(undefined); setDeviceError(''); }}>更换打印电脑</button>
      </>}
      {job && <p role='status' aria-live='polite' className={styles.notice}>{progress}</p>}
      {deviceError && <p role='alert' className={styles.error}>{deviceError}</p>}
      {jobError && <p role='alert' className={styles.error}>{jobError}</p>}
      {message && <p role='alert' className={styles.error}>{message}</p>}
    </div>
  </details>;
}

