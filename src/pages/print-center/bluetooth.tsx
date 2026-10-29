/* eslint-disable react/forbid-elements */
import { useCallback, useEffect, useRef, useState } from 'react';
import Taro from '@tarojs/taro';
import {
  connectBluetooth630K, getBluetooth630KState, isBluetooth630KSupported, queryBluetooth630KJob,
  readBluetooth630KPrinter, resolveBluetooth630KJob, sendBluetooth630KJob, watchBluetooth630K
} from '@/services/bluetooth-630k';
import type { Bluetooth630KState } from '@/services/bluetooth-630k';
import { readBluetooth630KPending, readRemotePrintPending } from '@/services/print-transport-pending';
import { newRemotePrintId } from '@/services/remote-print';
import type { SavedPrintNote } from '@/services/print-notes';
import type { DotMatrixSettings, PrintDocument } from '@/utils/dot-matrix-print';
import styles from './index.module.scss';

const UI_PENDING_KEY = 'warehouse_bluetooth_630k_ui_pending_v1';

type Attempt = {
  v: 1; id: string; noteId: number; noteNumber: string; version: number; paper: string;
  deviceId: string; relayId: string; status?: string; message?: string; updatedAt: number;
};

function readAttempt(key = UI_PENDING_KEY): Attempt | undefined {
  try {
    const value = Taro.getStorageSync(key);
    const parsed = typeof value === 'string' ? JSON.parse(value) : value;
    if (!parsed || parsed.v !== 1 || typeof parsed.id !== 'string' || !Number.isSafeInteger(parsed.noteId)
      || typeof parsed.noteNumber !== 'string' || !Number.isSafeInteger(parsed.version)
      || typeof parsed.paper !== 'string' || typeof parsed.deviceId !== 'string'
      || typeof parsed.relayId !== 'string' || !Number.isFinite(parsed.updatedAt)) return undefined;
    return parsed as Attempt;
  } catch { return undefined; }
}

function writeAttempt(value: Attempt): void {
  Taro.setStorageSync(`warehouse_bluetooth_630k_attempt:${value.relayId}:${value.noteId}:${value.version}:${value.paper}`, value);
  Taro.setStorageSync(UI_PENDING_KEY, value);
}

function writeTerminalAttempt(value: Attempt): void {
  Taro.setStorageSync(`warehouse_bluetooth_630k_attempt:${value.relayId}:${value.noteId}:${value.version}:${value.paper}`, value);
  const active = readAttempt();
  if (active?.id === value.id) Taro.removeStorageSync(UI_PENDING_KEY);
}

function readNoteAttempt(saved: SavedPrintNote | undefined, paper: string, relayId: string): Attempt | undefined {
  if (!saved || !relayId) return undefined;
  try {
    const value = Taro.getStorageSync(`warehouse_bluetooth_630k_attempt:${relayId}:${saved.id}:${saved.version}:${paper}`);
    const parsed = typeof value === 'string' ? JSON.parse(value) : value;
    return parsed && parsed.v === 1 && typeof parsed.id === 'string' ? parsed as Attempt : undefined;
  } catch { return undefined; }
}

const messageOf = (error: unknown): string => error instanceof Error ? error.message : '蓝牙打印暂时不可用，请重试';
const inFlightStatuses = new Set(['received', 'processing', 'uncertain']);
function hasUnresolvedNetworkPrint(): boolean {
  try { return !!readRemotePrintPending(true); } catch { return true; }
}

export default function Bluetooth630KPrint({ enabled, ready, saved, document, settings, autoSend, onReadyChange, onPendingChange }: {
  enabled: boolean; ready: boolean; saved?: SavedPrintNote; document: PrintDocument; settings: DotMatrixSettings;
  autoSend: boolean; onReadyChange?: (ready: boolean) => void; onPendingChange?: () => void;
}) {
  const supported = isBluetooth630KSupported();
  const [state, setState] = useState<Bluetooth630KState>(getBluetooth630KState);
  const [busy, setBusy] = useState(false);
  const [resolving, setResolving] = useState('');
  const [message, setMessage] = useState('');
  const [progress, setProgress] = useState('');
  const [attempt, setAttempt] = useState<Attempt>();
  const [confirmCopy, setConfirmCopy] = useState(false);
  const autoSent = useRef(false);
  const alive = useRef(true);
  const autoConnectAttempted = useRef(false);
  const operationInFlight = useRef(false);
  const queryInFlight = useRef(false);
  const resolveInFlight = useRef(false);
  const job = state.job;
  let pending;
  try { pending = readBluetooth630KPending(true); } catch { pending = { id: 'unknown-pending' }; }
  const activeAttempt = readAttempt();
  const currentNoteAttempt = readNoteAttempt(saved, settings.paper, state.printer?.relayId || readBluetooth630KPrinter()?.relayId || '');
  const attemptMatchesCurrentNote = (value?: Attempt) => !!value && !!saved && value.noteId === saved.id
    && value.version === saved.version && value.paper === settings.paper
    && (!state.printer?.relayId || value.relayId === state.printer.relayId);
  const visibleAttempt = attemptMatchesCurrentNote(attempt) ? attempt : currentNoteAttempt;
  const pendingAttempt = pending ? [activeAttempt, attempt, currentNoteAttempt].find(value => value?.id === pending.id) : undefined;
  const effectiveAttempt = pending ? pendingAttempt : visibleAttempt;
  const attemptSnapshot = useRef({ activeAttempt, attempt, currentNoteAttempt, pending, effectiveAttempt, printer: state.printer });
  attemptSnapshot.current = { activeAttempt, attempt, currentNoteAttempt, pending, effectiveAttempt, printer: state.printer };
  const activeJob = job && (pending ? job.id === pending.id : !!effectiveAttempt && job.id === effectiveAttempt.id) ? job : undefined;
  const blockedByNetwork = hasUnresolvedNetworkPrint();
  const shownStatus = activeJob?.status || effectiveAttempt?.status;
  const shownMessage = activeJob?.message || effectiveAttempt?.message;
  const shownNoteNumber = effectiveAttempt?.noteNumber;
  const shownId = pending?.id || activeJob?.id || effectiveAttempt?.id;
  const locked = !!pending;
  const canSend = enabled && supported && !!saved && !!state.connected && !busy && !resolving && !locked && !blockedByNetwork;
  const physicalCheck = activeJob?.status === 'uncertain';
  const queueAccepted = shownStatus === 'queued';

  useEffect(() => {
    alive.current = true;
    const stop = watchBluetooth630K(next => {
      if (!alive.current) return;
      setState(next);
      if (!next.job) return;
      const meta = readAttempt();
      if (meta?.id !== next.job.id) return;
      const updated = { ...meta, status: next.job.status, message: next.job.message, updatedAt: next.job.updatedAt };
      try {
        if (inFlightStatuses.has(next.job.status)) writeAttempt(updated);
        else writeTerminalAttempt(updated);
        setAttempt(updated);
      } catch { setMessage('打印状态已更新，但本机未能保存恢复记录'); }
    });
    onPendingChange?.();
    return () => { alive.current = false; stop(); };
  }, [onPendingChange]);

  useEffect(() => {
    if (!enabled || !supported || autoConnectAttempted.current) return;
    if (state.connected) { autoConnectAttempted.current = true; return; }
    if (busy) return;
    const printer = readBluetooth630KPrinter();
    if (!printer) return;
    autoConnectAttempted.current = true;
    let active = true;
    void connectBluetooth630K(false).then(() => { if (active) setState(getBluetooth630KState()); })
      .catch(issue => { if (active) setMessage(messageOf(issue)); });
    return () => { active = false; };
  }, [enabled, supported, state.connected, busy]);

  useEffect(() => {
    if (!saved) { setAttempt(undefined); return; }
    const printer = state.printer || readBluetooth630KPrinter();
    if (!printer) return;
    const local = readNoteAttempt(saved, settings.paper, printer.relayId);
    setAttempt(local);
  }, [saved, settings.paper, state.printer]);

  const pollingId = pending?.id || (inFlightStatuses.has(currentNoteAttempt?.status || '') ? currentNoteAttempt?.id : '');
  useEffect(() => {
    if (!enabled || !supported || !state.connected || !pollingId || pollingId === 'unknown-pending') return;
    let active = true;
    const poll = async () => {
      if (!active || operationInFlight.current || queryInFlight.current || resolveInFlight.current) return;
      operationInFlight.current = true; queryInFlight.current = true; setBusy(true);
      try {
        // Poll only the persisted original task ID; never submit a replacement or select another device.
        const result = await queryBluetooth630KJob(pollingId);
        if (!active) return;
        const latest = attemptSnapshot.current;
        const meta = [latest.activeAttempt, latest.attempt, latest.currentNoteAttempt].find(value => value?.id === pollingId) || {
          v: 1 as const, id: pollingId, noteId: 0, noteNumber: '未知单据', version: 0, paper: '',
          deviceId: latest.pending?.deviceId || latest.printer?.deviceId || '',
          relayId: latest.pending?.relayId || latest.printer?.relayId || readBluetooth630KPrinter()?.relayId || '', updatedAt: Date.now()
        };
        const next = { ...meta, status: result.status, message: result.message, updatedAt: result.updatedAt };
        if (inFlightStatuses.has(result.status)) writeAttempt(next); else writeTerminalAttempt(next);
        setAttempt(next); setState(getBluetooth630KState()); setMessage(''); onPendingChange?.();
      } catch (issue) {
        if (active) setMessage(`原蓝牙任务暂时无法查询：${messageOf(issue)}；请保持当前打印通道，不要重发`);
      } finally {
        queryInFlight.current = false; operationInFlight.current = false;
        // The polling effect may be cancelled on disconnect while this query is still in flight.
        // Release the UI lock whenever the component remains mounted; only effect work is stale.
        if (alive.current) setBusy(false);
      }
    };
    const timer = window.setInterval(() => { void poll(); }, 1000);
    return () => { active = false; window.clearInterval(timer); };
  }, [enabled, supported, state.connected, pollingId, onPendingChange]);

  useEffect(() => { if (onReadyChange) onReadyChange(supported && !!state.connected); }, [supported, state.connected, onReadyChange]);

  const connect = useCallback(async (selectNew: boolean) => {
    if (busy || operationInFlight.current || resolveInFlight.current) return;
    operationInFlight.current = true;
    setBusy(true); setMessage('');
    try { await connectBluetooth630K(selectNew); setState(getBluetooth630KState()); }
    catch (issue) { setMessage(messageOf(issue)); setState(getBluetooth630KState()); }
    finally { operationInFlight.current = false; setBusy(false); }
  }, [busy]);

  const refresh = useCallback(async () => {
    if (!state.connected || busy || operationInFlight.current || queryInFlight.current || resolveInFlight.current) return;
    const id = pending?.id || effectiveAttempt?.id;
    if (!id || id === 'unknown-pending') { setState(getBluetooth630KState()); return; }
    operationInFlight.current = true; queryInFlight.current = true;
    setBusy(true); setMessage('');
    try {
      const result = await queryBluetooth630KJob(id);
      const latest = attemptSnapshot.current;
      const meta = [latest.activeAttempt, latest.attempt, latest.currentNoteAttempt].find(value => value?.id === id) || {
        v: 1 as const, id, noteId: 0, noteNumber: '未知单据', version: 0, paper: '',
        deviceId: latest.pending?.deviceId || state.printer?.deviceId || '',
        relayId: latest.pending?.relayId || state.printer?.relayId || readBluetooth630KPrinter()?.relayId || '', updatedAt: Date.now()
      };
      const next = { ...meta, status: result.status, message: result.message, updatedAt: result.updatedAt };
      if (inFlightStatuses.has(result.status)) writeAttempt(next); else writeTerminalAttempt(next);
      setAttempt(next); setState(getBluetooth630KState());
    } catch (issue) { setMessage(`原蓝牙任务暂时无法查询：${messageOf(issue)}；请勿重新发送`); }
    finally { queryInFlight.current = false; operationInFlight.current = false; setBusy(false); }
  }, [state.connected, state.printer, busy, pending?.id, effectiveAttempt?.id]);

  const send = useCallback(async (newCopy = false) => {
    if (!saved || !state.connected || busy || operationInFlight.current || queryInFlight.current || resolveInFlight.current || locked) return;
    const printer = state.printer || readBluetooth630KPrinter();
    if (!printer) { setMessage('请先连接630K蓝牙打印电脑'); return; }
    const old = readNoteAttempt(saved, settings.paper, printer.relayId);
    if (old?.status && inFlightStatuses.has(old.status)) { setMessage('这张单据的原蓝牙任务仍在处理中，请查询原任务，不要重发'); return; }
    if (old?.status === 'queued' && !newCopy) { setConfirmCopy(true); return; }
    const id = !newCopy && old ? old.id : newRemotePrintId();
    const next: Attempt = { v: 1, id, noteId: saved.id, noteNumber: saved.number, version: saved.version, paper: settings.paper,
      deviceId: printer.deviceId, relayId: printer.relayId, updatedAt: Date.now() };
    let attemptPersisted = false;
    operationInFlight.current = true;
    setBusy(true); setProgress(''); setMessage(''); setConfirmCopy(false);
    try {
      if (readRemotePrintPending(true)) { setMessage('网络打印还有未确认的原任务，请先切回网络打印查询并核对'); return; }
      // Persist bill identity and idempotency key before any BLE transfer begins.
      writeAttempt(next); attemptPersisted = true; setAttempt(next); onPendingChange?.();
      const result = await sendBluetooth630KJob({ id, document, settings }, (sent, total) => {
        if (alive.current) setProgress(`正在通过蓝牙发送 ${Math.floor(sent * 100 / total)}%`);
      });
      const updated = { ...next, status: result.status, message: result.message, updatedAt: result.updatedAt };
      if (inFlightStatuses.has(result.status)) writeAttempt(updated); else writeTerminalAttempt(updated);
      setAttempt(updated); setState(getBluetooth630KState()); onPendingChange?.();
    } catch (issue) {
      // The BLE service reports post-commit ambiguity as an uncertain job; a thrown
      // pre-commit failure is safe to retry with this saved attempt id.
      if (!attemptPersisted) { setMessage(messageOf(issue)); return; }
      const nextState = getBluetooth630KState();
      const currentPending = readBluetooth630KPending();
      if (nextState.job?.id === id && inFlightStatuses.has(nextState.job.status)) {
        const uncertain = { ...next, status: nextState.job.status, message: nextState.job.message, updatedAt: nextState.job.updatedAt };
        writeAttempt(uncertain); setAttempt(uncertain);
      } else if (!currentPending) {
        const failed = { ...next, status: 'failed', message: messageOf(issue), updatedAt: Date.now() };
        writeTerminalAttempt(failed); setAttempt(failed);
      }
      setState(nextState); setMessage(messageOf(issue)); onPendingChange?.();
    } finally { operationInFlight.current = false; setBusy(false); }
  }, [saved, state.connected, state.printer, busy, locked, settings, document, onPendingChange]);

  const resolve = useCallback(async (outcome: 'printed' | 'missing') => {
    const id = activeJob?.id || pending?.id;
    if (!id || id === 'unknown-pending' || !state.connected || busy || resolving || operationInFlight.current || queryInFlight.current || resolveInFlight.current) return;
    resolveInFlight.current = true;
    setResolving(outcome); setMessage('');
    try {
      const result = await resolveBluetooth630KJob(id, outcome);
      const latest = attemptSnapshot.current;
      const meta = (latest.activeAttempt?.id === id ? latest.activeAttempt : latest.effectiveAttempt);
      if (meta) {
        const next = { ...meta, status: result.status, message: result.message, updatedAt: result.updatedAt };
        if (inFlightStatuses.has(result.status)) writeAttempt(next); else writeTerminalAttempt(next);
        setAttempt(next);
      }
      setState(getBluetooth630KState()); onPendingChange?.();
    } catch (issue) { setMessage(messageOf(issue)); }
    finally { resolveInFlight.current = false; setResolving(''); }
  }, [activeJob?.id, pending?.id, state.connected, busy, resolving, onPendingChange]);

  useEffect(() => { autoSent.current = false; setConfirmCopy(false); }, [saved?.id, saved?.version]);
  useEffect(() => {
    if (!enabled || !ready || !autoSend || !saved?.id || !state.connected || busy || pending?.id || blockedByNetwork || currentNoteAttempt?.id || autoSent.current) return;
    autoSent.current = true;
    void send(false);
  }, [enabled, ready, autoSend, saved?.id, state.connected, busy, pending?.id, blockedByNetwork, currentNoteAttempt?.id, send]);

  if (!enabled) return null;
  if (!supported) return <section className={styles.settings} data-transport='bluetooth'><summary>630K 蓝牙打印</summary><div className={styles.settingsBody}><p className={styles.muted}>此设备没有可用的蓝牙打印组件，请选择网络打印。</p></div></section>;


  return <section className={styles.settings} data-transport='bluetooth' aria-label='630K蓝牙打印'>
    <summary>蓝牙直连打印 · {state.connected ? state.printer?.name || '630K打印电脑已连接' : '未连接打印电脑'}</summary>
    <div className={styles.settingsBody}>
      <p className={styles.muted}>手机蓝牙连接店内中继电脑，由中继调用 EPSON LQ-630K 的 Windows 打印驱动；不需要连接码。</p>
      {state.connected ? <p className={styles.notice}>已连接：{state.printer?.name || '630K打印电脑'}</p>
        : <button type='button' className={styles.secondary} disabled={busy || (locked && !readBluetooth630KPrinter())} onClick={() => void connect(!readBluetooth630KPrinter())}>{busy ? '正在连接…' : readBluetooth630KPrinter() ? '重连630K打印电脑' : '选择630K打印电脑'}</button>}
      {state.error && <p role='alert' className={styles.error}>{state.error}</p>}
      {shownId && <div className={styles.notice} role='status'>
        {pending ? <>原蓝牙任务 {shownNoteNumber || '待核对单据'}（{shownId}）尚未完成。请先重连并查询原任务，不能切换到别的打印电脑或打印新单。</>
          : shownStatus === 'processing' || shownStatus === 'received' ? <>单据 {shownNoteNumber || '当前单据'} 的原任务正在处理中（{shownId}），不会重发。</>
            : shownStatus === 'uncertain' ? <>单据 {shownNoteNumber || '当前单据'} 的打印结果尚未确认（{shownId}），请连接原打印电脑并核对。</>
              : shownStatus === 'queued' ? <>单据 {shownNoteNumber || '当前单据'} 已进入 Windows 打印队列；这不代表已经实际出纸。{shownMessage ? ` ${shownMessage}` : ''}</>
                : shownStatus === 'failed' ? <>上次蓝牙打印失败：{shownMessage || '任务失败'}。可使用同一任务编号重试。</>
                  : null}
      </div>}
      {progress && <p className={styles.muted} role='status'>{progress}</p>}
      {message && <p className={styles.error} role='alert'>{message}</p>}
      {blockedByNetwork && !pending && <p className={styles.error} role='alert'>网络打印有待确认任务，请切回网络打印查询原任务。</p>}
      <div className={styles.previewControls}>
        <button type='button' className={styles.secondary} disabled={!state.connected || busy || !!resolving || !shownId} onClick={() => void refresh()}>{busy ? '正在处理…' : '查询原任务'}</button>
        {queueAccepted && <button type='button' className={styles.secondary} disabled={!state.connected || !!resolving} onClick={() => void resolve('printed')}>{resolving === 'printed' ? '正在记录…' : '已经出纸了'}</button>}
        {physicalCheck && <div role='group' aria-label='核对实际出纸'>
          <p className={styles.muted}>请到打印机前检查纸张。核对前会暂停两种通道的新打印任务。</p>
          <button type='button' className={styles.primary} disabled={!state.connected || !!resolving} onClick={() => void resolve('printed')}>{resolving === 'printed' ? '正在确认…' : '已经出纸了'}</button>
          <button type='button' className={styles.secondary} disabled={!state.connected || !!resolving} onClick={() => void resolve('missing')}>{resolving === 'missing' ? '正在确认…' : '没有出纸'}</button>
        </div>}
      </div>
      {saved && !locked && !blockedByNetwork && !physicalCheck && <div className={styles.previewControls}>
        <button type='button' className={styles.primary} disabled={!canSend} onClick={() => {
          if (queueAccepted) setConfirmCopy(true);
          else void send(false);
        }}>{busy ? '正在发送…' : queueAccepted ? '再打印一份' : shownStatus === 'failed' ? '重试原任务' : '发送到630K蓝牙打印机'}</button>
        {confirmCopy && <div role='group' aria-label='确认蓝牙重新打印'>
          <p className={styles.muted}>请确认已检查上一份打印结果；将使用新的任务编号再次打印。</p>
          <button type='button' className={styles.secondary} onClick={() => setConfirmCopy(false)}>取消</button>
          <button type='button' className={styles.primary} disabled={!canSend || blockedByNetwork} onClick={() => void send(true)}>确认再打印一份</button>
        </div>}
      </div>}
      {!saved && <p className={styles.muted}>请先保存单据，再通过蓝牙发送到630K。</p>}
    </div>
  </section>;
}
