/* eslint-disable react/forbid-elements */
import { useEffect, useMemo, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import type { PrintNoteInput, SavedPrintNote } from '@/services/print-notes';
import { buildDotMatrixHtml, mountDotMatrixPrintDocument, paginateDotMatrixDocument } from '@/utils/dot-matrix-print';
import { downloadPrintPdf, getLocalPrintBridge } from '@/utils/local-print';
import type { LocalPrinter } from '@/utils/local-print';
import { printDocument, printSettings } from './model';
import styles from './index.module.scss';
import RemotePrint, { useRemotePrint } from './remote';
import { refreshPrintNotices } from '@/services/print-notifications';
import { useMobilePrintNotifications } from '@/services/mobile-print-notifications';

export default function PrintPreview({ note, saved, reprintIntent = false, autoSend = false, onClose }: {
  note: PrintNoteInput;
  saved?: SavedPrintNote;
  reprintIntent?: boolean;
  autoSend?: boolean;
  onClose: () => void;
}) {
  const [paper] = useState(note.paper);
  const settings = useMemo(() => printSettings({ ...note, paper }), [note, paper]);
  const doc = useMemo(() => printDocument(note, saved), [note, saved]);
  const html = useMemo(() => buildDotMatrixHtml(doc, settings), [doc, settings]);
  const [loaded, setLoaded] = useState('');
  const [layout, setLayout] = useState({ pages: 0, height: 380 });
  const [availableWidth, setAvailableWidth] = useState(300);
  const [zoomed, setZoomed] = useState(false);
  const [error, setError] = useState('');
  const [message, setMessage] = useState('');
  const [printing, setPrinting] = useState(false);
  const bridge = useMemo(getLocalPrintBridge, []);
  const [printers, setPrinters] = useState<LocalPrinter[]>([]);
  const [printerName, setPrinterName] = useState('');
  const [printerLoading, setPrinterLoading] = useState(!!bridge);
  const [printerError, setPrinterError] = useState('');
  const [printerRetry, setPrinterRetry] = useState(0);
  const frame = useRef<HTMLIFrameElement>(null);
  const stage = useRef<HTMLDivElement>(null);
  const cleanupPrint = useRef<(() => void) | null>(null);
  const busy = useRef(false);
  const attempt = useRef<{ fingerprint: string; id: string }>();
  const native = !!(window as any).Capacitor?.isNativePlatform?.();
  const ready = loaded === html && !error;
  const width = settings.width * 96 / 25.4 + 24;
  const scale = zoomed ? 1 : Math.min(1, Math.max(.1, availableWidth / width));
  const selectedPrinter = printers.find(printer => printer.name === printerName);
  const mobileNotices = useMobilePrintNotifications();
  const savedMatch = useMemo(() => saved && JSON.stringify(printDocument(saved, saved)) === JSON.stringify(doc) ? saved : undefined, [doc, saved]);
  const remote = useRemotePrint(savedMatch, paper);
  const [remoteOpen, setRemoteOpen] = useState(false);
  const autoSubmitted = useRef(false);
  const close = useRef(onClose);
  const { canSend, job: remoteJob, send: sendRemote } = remote;
  close.current = onClose;

  useEffect(() => {
    if (native && (remote.token || remote.pending)) setRemoteOpen(true);
  }, [native, remote.token, remote.pending]);

  useEffect(() => {
    if (native && autoSend && (remote.message || remote.jobError)) setRemoteOpen(true);
  }, [native, autoSend, remote.message, remote.jobError]);

  // Automatic dispatch is limited to explicit direct-print and opted-in outbound
  // intents. It starts only after layout and task recovery. Existing tasks are
  // observed, never replaced by an automatic second copy; one failed attempt is
  // left for the user to retry, retaining its persisted task id.
  useEffect(() => {
    if (!native || !autoSend || !ready || !canSend || remoteJob || autoSubmitted.current) return;
    autoSubmitted.current = true;
    void sendRemote();
  }, [native, autoSend, ready, canSend, remoteJob, sendRemote]);

  const autoCloseId = native && remote.job?.id === remote.lastSentId
    && ['processing', 'queued'].includes(remote.job.status) ? remote.job.id : '';
  useEffect(() => {
    if (!autoCloseId) return;
    if (mobileNotices) void refreshPrintNotices();
    const timer = setTimeout(() => close.current(), 1500);
    return () => clearTimeout(timer);
  }, [autoCloseId, mobileNotices]);

  useEffect(() => {
    const container = stage.current;
    if (!container) return;
    const resize = () => setAvailableWidth(container.clientWidth);
    resize();
    const observer = typeof ResizeObserver === 'undefined' ? null : new ResizeObserver(resize);
    observer?.observe(container); window.addEventListener('resize', resize);
    return () => { observer?.disconnect(); window.removeEventListener('resize', resize); };
  }, []);
  useEffect(() => {
    if (!bridge) return;
    let active = true; setPrinterLoading(true); setPrinterError('');
    bridge.listPrinters().then(list => {
      if (!active) return;
      setPrinters(list); setPrinterName(previous => previous || list.find(printer => printer.isDefault && !printer.unavailable)?.name || list.find(printer => !printer.unavailable)?.name || '');
    }).catch(issue => { if (active) setPrinterError(issue instanceof Error ? issue.message : '读取打印机失败'); })
      .finally(() => { if (active) setPrinterLoading(false); });
    return () => { active = false; };
  }, [bridge, printerRetry]);
  useEffect(() => {
    const clear = () => { cleanupPrint.current?.(); cleanupPrint.current = null; };
    const before = () => {
      if (native || !ready || cleanupPrint.current || !frame.current?.contentDocument) return;
      cleanupPrint.current = mountDotMatrixPrintDocument(frame.current.contentDocument, settings, document);
    };
    window.addEventListener('beforeprint', before); window.addEventListener('afterprint', clear);
    return () => { window.removeEventListener('beforeprint', before); window.removeEventListener('afterprint', clear); clear(); };
  }, [native, ready, settings]);
  useEffect(() => {
    const key = (event: KeyboardEvent) => {
      if (event.key !== 'Escape' || busy.current) return;
      if (zoomed) setZoomed(false); else onClose();
    };
    window.addEventListener('keydown', key); return () => window.removeEventListener('keydown', key);
  }, [onClose, zoomed]);
  const load = async () => {
    const element = frame.current, content = element?.contentDocument;
    if (!content || element?.srcdoc !== html) return;
    try {
      await content.fonts?.ready;
      if (frame.current !== element || element.srcdoc !== html || element.contentDocument !== content) return;
      setLayout(paginateDotMatrixDocument(content, doc, settings)); setError(''); setLoaded(html);
    } catch (issue) { setError(issue instanceof Error ? issue.message : '排版失败，请调整纸张'); setLoaded(''); }
  };
  const print = async () => {
    if (!ready || busy.current) return;
    busy.current = true; setPrinting(true); setMessage('');
    try {
      if (bridge) {
        if (!selectedPrinter || selectedPrinter.unavailable) throw new Error('请选择可用的打印机');
        const fingerprint = JSON.stringify({ doc, settings, printerName });
        if (attempt.current?.fingerprint !== fingerprint) attempt.current = { fingerprint, id: `delivery-${Date.now()}-${Math.random().toString(36).slice(2)}` };
        const result = await bridge.print({ id: attempt.current.id, printerName, document: doc, settings });
        if (result.kind === 'pdf' && result.pdf) { downloadPrintPdf(result.pdf, doc.number); setMessage('PDF 已生成'); }
        else setMessage(`已发送到 ${result.printerName}，共 ${result.pages} 页`);
        attempt.current = undefined;
      } else {
        if (native || !frame.current?.contentDocument || typeof window.print !== 'function') throw new Error('请在电脑打开同一张已保存的单据打印');
        cleanupPrint.current?.(); cleanupPrint.current = mountDotMatrixPrintDocument(frame.current.contentDocument, settings, document);
        window.print(); setMessage('已打开系统打印，请使用 100% 比例并关闭页眉页脚');
      }
    } catch (issue) {
      if ((issue as { safeToRetry?: boolean })?.safeToRetry) attempt.current = undefined;
      cleanupPrint.current?.(); cleanupPrint.current = null; setMessage(issue instanceof Error ? issue.message : '打印失败，请重试');
    } finally { busy.current = false; setPrinting(false); }
  };

  const mobileAction = (() => {
    if (!remote.token) return {
      label: '连接打印电脑', disabled: false,
      run: () => {
        setRemoteOpen(true);
        setTimeout(() => document.querySelector<HTMLInputElement>('[aria-label="打印电脑配对码"]')?.focus(), 60);
      }
    };
    if (!savedMatch) return { label: '保存后才能打印', disabled: true, run: () => {} };
    if (remote.busy) return { label: '正在发送…', disabled: true, run: () => {} };
    if (remote.job?.status === 'uncertain') return { label: '待核对出纸', disabled: false, run: () => setRemoteOpen(true) };
    if (remote.pending) return { label: '任务处理中…', disabled: true, run: () => {} };
    if (remote.deviceError) return { label: '重试连接', disabled: false, run: () => remote.requestRefresh() };
    if (!remote.device) return { label: '正在连接电脑…', disabled: true, run: () => {} };
    if (remote.checking) return { label: '正在查询上次打印…', disabled: true, run: () => {} };
    if (remote.terminal) return reprintIntent
      ? { label: '再打印一份', disabled: !remote.canSend, run: () => void remote.send(true) }
      : { label: '再打印一份', disabled: !remote.canSend, run: () => { setRemoteOpen(true); remote.setConfirmCopy(true); } };
    return { label: '发送到630K', disabled: !remote.canSend, run: () => void remote.send() };
  })();

  return createPortal(<div className={styles.backdrop}><section role='dialog' aria-modal='true' aria-label='送货单预览' className={styles.previewDialog} data-mobile={native ? 'true' : undefined}>
    <div className={styles.previewHeader}><h2>送货单预览</h2><button type='button' className={styles.textButton} disabled={printing} onClick={onClose}>关闭</button></div>
    {bridge && <div className={styles.previewControls}><select aria-label='打印机' value={printerName} disabled={printerLoading || printing} onChange={event => setPrinterName(event.target.value)}><option value=''>{printerLoading ? '正在读取打印机…' : '请选择打印机'}</option>{printers.map(printer => <option key={printer.name} value={printer.name} disabled={printer.unavailable}>{printer.displayName}{printer.unavailable ? '（不可用）' : ''}</option>)}</select><button type='button' disabled={printerLoading || printing} onClick={() => setPrinterRetry(value => value + 1)}>刷新</button></div>}
    {printerError && <p role='alert' className={styles.error}>{printerError}</p>}{error && <p role='alert' className={styles.error}>{error}</p>}
    <div className={styles.previewStage} ref={stage}><button type='button' className={styles.previewTrigger} aria-label={zoomed ? '缩小送货单预览' : '放大送货单预览'} aria-pressed={zoomed} disabled={!ready} onClick={() => setZoomed(value => !value)}><span className={styles.frameShell} style={{ width: width * scale, height: layout.height * scale }}><iframe key={html} ref={frame} title='送货单纸张预览' tabIndex={-1} sandbox='allow-same-origin allow-modals' srcDoc={html} onLoad={load} style={{ width, height: layout.height, transform: `scale(${scale})` }} /></span></button></div>
    <RemotePrint remote={remote} open={remoteOpen} onOpenChange={setRemoteOpen} showSendAction={!native} />
    <p className={styles.muted}>{ready ? `共 ${layout.pages} 页 · 规格使用 × · 单位为个` : '正在排版…'}</p>
    {message && <p role='status' className={styles.notice}>{message}</p>}
    <div className={styles.previewActions}><button type='button' className={styles.secondary} disabled={printing} onClick={zoomed ? () => setZoomed(false) : onClose}>{zoomed ? '缩小预览' : '返回单据'}</button>{native ? <button type='button' className={styles.primary} disabled={!ready || mobileAction.disabled} onClick={mobileAction.run}>{mobileAction.label}</button> : <button type='button' className={styles.primary} disabled={!ready || printing || (!!bridge && (printerLoading || !!printerError || !selectedPrinter || selectedPrinter.unavailable))} onClick={() => void print()}>{printing ? '正在发送…' : selectedPrinter?.isPdf ? '保存 PDF' : '打印送货单'}</button>}</div>
  </section></div>, document.body);
}
