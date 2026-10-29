/* eslint-disable react/forbid-elements */
import { useEffect, useId, useRef } from 'react';
import { createPortal } from 'react-dom';
import Taro from '@tarojs/taro';
import { returnToBusinessHome } from '@/services/business-navigation';
import './style.scss';

export const closeBusinessSheet = () => Taro.getCurrentPages().length > 1
  ? void Taro.navigateBack() : void returnToBusinessHome();

export function DemoSheet({ title, children, onClose = closeBusinessSheet, busy = false, testId }: {
  title: string; children: React.ReactNode; onClose?: () => void; busy?: boolean; testId?: string;
}) {
  const id = useId();
  const sheet = useRef<HTMLElement>(null);
  const closing = useRef(onClose);
  const locked = useRef(busy);
  closing.current = onClose; locked.current = busy;
  useEffect(() => {
    const previous = document.activeElement as HTMLElement | null;
    const onKey = (event: KeyboardEvent) => {
      const dialogs = document.querySelectorAll('.demo-dialog');
      if (dialogs[dialogs.length - 1] !== sheet.current) return;
      if (event.key === 'Escape' && !locked.current) closing.current();
      if (event.key !== 'Tab') return;
      const items = Array.from(sheet.current?.querySelectorAll<HTMLElement>('button:not(:disabled), input:not(:disabled), select:not(:disabled), textarea:not(:disabled), [tabindex="0"]') || [])
        .filter(element => element.getBoundingClientRect().height > 0);
      if (!items.length) { event.preventDefault(); return; }
      if (event.shiftKey && document.activeElement === items[0]) { event.preventDefault(); items[items.length - 1].focus(); }
      else if (!event.shiftKey && document.activeElement === items[items.length - 1]) { event.preventDefault(); items[0].focus(); }
    };
    const overlay = sheet.current?.parentElement;
    const preventOutsideScroll = (event: WheelEvent) => { if (event.target === overlay) event.preventDefault(); };
    overlay?.addEventListener('wheel', preventOutsideScroll, { passive: false });
    document.addEventListener('keydown', onKey);
    sheet.current?.querySelector<HTMLButtonElement>('[aria-label="关闭"]')?.focus({ preventScroll: true });
    return () => {
      document.removeEventListener('keydown', onKey);
      overlay?.removeEventListener('wheel', preventOutsideScroll);
      if (previous?.isConnected) previous.focus({ preventScroll: true });
    };
  }, []);
  return createPortal(<div className='demo-backdrop' onClick={event => { if (event.target === event.currentTarget && !busy) onClose(); }}>
    <section ref={sheet} className='demo-dialog' role='dialog' aria-modal='true' aria-labelledby={id} data-testid={testId}>
      <header className='demo-dialog-head'><h2 id={id}>{title}</h2><button type='button' className='demo-close' aria-label='关闭' disabled={busy} onClick={onClose}>×</button></header>
      {children}
    </section>
  </div>, document.body);
}

export function DemoField({ label, children, className = '' }: { label: string; children: React.ReactNode; className?: string }) {
  return <div className={`demo-field ${className}`}><label>{label}{children}</label></div>;
}
export function DemoDetail({ label, children }: { label: string; children: React.ReactNode }) {
  return <div className='demo-detail'><span>{label}</span><strong>{children}</strong></div>;
}
export function DemoPage({ title, subtitle, children, action, className = '' }: {
  title: string; subtitle?: string; children: React.ReactNode; action?: React.ReactNode; className?: string;
}) {
  return <main className={`demo-page ${className}`} data-ui-version='web-workbench-v2' data-layout='demo-layout-v2'>
    <header className='demo-page-header'><div className='demo-page-top'><button type='button' className='demo-back' aria-label='返回总台' onClick={closeBusinessSheet}>‹</button><div><span className='demo-brand'>曙光库存</span><h1>{title}</h1></div>{action && <div className='demo-header-action'>{action}</div>}</div>{subtitle && <p>{subtitle}</p>}</header>
    <div className='demo-page-content'>{children}</div>
  </main>;
}
