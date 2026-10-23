/* eslint-disable react/forbid-elements */
import { useEffect, useState } from 'react';
import Taro from '@tarojs/taro';
import {
  describePrintNotice, dismissPrintNotice, refreshPrintNotices, resolvePrintNotice,
  startPrintNoticeMonitor, usePrintNotices
} from '@/services/print-notifications';
import { useMobilePrintNotifications } from '@/services/mobile-print-notifications';
import styles from './index.module.scss';

function BellIcon() {
  return <span className={styles.icon} aria-hidden='true'>
    <svg viewBox='0 0 24 24' fill='none' stroke='currentColor' strokeWidth='1.8' strokeLinecap='round' strokeLinejoin='round'>
      <path d='M18 8a6 6 0 0 0-12 0c0 7-3 7-3 9h18c0-2-3-2-3-9' /><path d='M10 21h4' />
    </svg>
  </span>;
}

function RefreshIcon() {
  return <svg viewBox='0 0 24 24' fill='none' stroke='currentColor' strokeWidth='1.9' strokeLinecap='round' strokeLinejoin='round' aria-hidden='true'>
    <path d='M20 11a8 8 0 1 0-2.3 5.7' /><path d='M20 4v7h-7' />
  </svg>;
}

// Mounted at the app root so a status change still reaches the operator after
// they leave the print center. It renders no desktop UI.
export function PrintNotificationMonitor() {
  const mobile = useMobilePrintNotifications();

  useEffect(() => {
    if (!mobile) return;
    return startPrintNoticeMonitor();
  }, [mobile]);

  return null;
}

export default function PrintNotifications({ onOpenNote, global = false }: {
  onOpenNote?: (id: number) => void;
  global?: boolean;
}) {
  const mobile = useMobilePrintNotifications();
  const snapshot = usePrintNotices();
  const [resolving, setResolving] = useState('');
  const [route, setRoute] = useState(() => typeof location === 'undefined' ? '' : location.hash);
  const active = snapshot.records.filter(record => !record.dismissed);
  // A manual check must never be hidden behind a newer routine update.
  const latest = active.find(record => record.job?.status === 'uncertain') || active[0];

  useEffect(() => {
    if (!global || typeof window === 'undefined') return;
    const changed = () => setRoute(location.hash);
    window.addEventListener('hashchange', changed);
    window.addEventListener('popstate', changed);
    return () => {
      window.removeEventListener('hashchange', changed);
      window.removeEventListener('popstate', changed);
    };
  }, [global]);

  if (!mobile || !latest) return null;
  if (global && /pages\/print-center/.test(route)) return null;
  const description = describePrintNotice(latest, snapshot);
  const uncertain = latest.job?.status === 'uncertain';
  const busy = !!resolving || snapshot.checking;
  const open = () => {
    dismissPrintNotice(latest.id);
    if (onOpenNote) { onOpenNote(latest.noteId); return; }
    void Taro.switchTab({ url: '/pages/print-center/index' });
  };
  const resolve = async (outcome: 'printed' | 'missing') => {
    setResolving(outcome);
    try { await resolvePrintNotice(latest.id, outcome); }
    catch (issue) { void Taro.showToast({ title: issue instanceof Error ? issue.message : '确认失败，请重试', icon: 'none' }); }
    finally { setResolving(''); }
  };

  return <section className={styles.banner} data-tone={description.tone} data-print-notice={latest.id}
    data-global={global ? 'true' : undefined}
    aria-live={description.tone === 'danger' ? 'assertive' : 'polite'} role={description.tone === 'danger' ? 'alert' : 'status'}>
    <button type='button' className={styles.main} onClick={open}
      aria-label={`${description.title}，打开单据查看`}>
      <BellIcon />
      <span className={styles.copy}>
        <strong>{description.title}</strong>
        <span className={styles.meta}>{latest.noteNumber || '送货单'} · {latest.printer}</span>
        <small>{description.message}</small>
      </span>
    </button>
    <div className={styles.actions}>
      {uncertain ? <>
        <button type='button' className={styles.resolveButton} disabled={busy} onClick={() => void resolve('printed')}>
          {resolving === 'printed' ? '确认中…' : '已出纸'}
        </button>
        <button type='button' className={styles.resolveButton} disabled={busy} onClick={() => void resolve('missing')}>
          {resolving === 'missing' ? '确认中…' : '未出纸'}
        </button>
      </> : <button type='button' className={styles.iconButton} aria-label='刷新通知状态' title='刷新通知状态'
        disabled={busy} onClick={() => void refreshPrintNotices()}>
        <RefreshIcon />
      </button>}
      <button type='button' className={styles.iconButton} aria-label='关闭打印通知' title='关闭打印通知'
        onClick={() => dismissPrintNotice(latest.id)}>
        <svg viewBox='0 0 24 24' fill='none' stroke='currentColor' strokeWidth='2' strokeLinecap='round' aria-hidden='true'><path d='M6 6l12 12M18 6 6 18' /></svg>
      </button>
    </div>
  </section>;
}
