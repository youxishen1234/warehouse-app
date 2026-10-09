/* eslint-disable react/forbid-elements */
// Native selects are intentional for the desktop browser printing workflow.
// Text inputs keep their DOM draft while WebKit processes numeric blur and preview layout updates.
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { View, Text } from '@tarojs/components';
import Taro from '@tarojs/taro';
import { buildDotMatrixHtml, DEFAULT_PRINT_SETTINGS, mountDotMatrixPrintDocument, normalizePrintSettings, paginateDotMatrixDocument, PAPER_PRESETS, samplePrintDocument } from '@/utils/dot-matrix-print';
import type { DotMatrixSettings, PrintDocument } from '@/utils/dot-matrix-print';
import { downloadPrintPdf, getLocalPrintBridge } from '@/utils/local-print';
import type { LocalPrinter } from '@/utils/local-print';
import DocumentEditor from './DocumentEditor';
import styles from './index.module.scss';

// Retain paper and calibration settings when adopting the editable four-row form.
const STORAGE_KEY = 'sg_dot_matrix_settings_v13';
const LEGACY_STORAGE_KEYS = ['sg_dot_matrix_settings_v8', 'sg_dot_matrix_settings_v7', 'sg_dot_matrix_settings_v6', 'sg_dot_matrix_settings_v5', 'sg_dot_matrix_settings_v4', 'sg_dot_matrix_settings_v3', 'sg_dot_matrix_settings_v2', 'sg_dot_matrix_settings_v1'];
const PRINTER_KEY = 'sg_dot_matrix_printer_v1';
const readSettings = () => {
  try {
    const current = Taro.getStorageSync(STORAGE_KEY);
    if (current && typeof current === 'object') return normalizePrintSettings(current);
    for (const key of LEGACY_STORAGE_KEYS) {
      const legacy = Taro.getStorageSync(key);
      if (legacy && typeof legacy === 'object') return normalizePrintSettings({ ...legacy, template: 'delivery-note', formTitle: DEFAULT_PRINT_SETTINGS.formTitle, paper: '241-93', width: 241, height: 93, rowsPerPage: 5, fontSize: 10, offsetX: 0, offsetY: 5, highClarity: true });
    }
    return { ...DEFAULT_PRINT_SETTINGS, template: 'delivery-note' as const, rowsPerPage: 5, offsetX: 0, offsetY: 5 };
  }
  catch { return { ...DEFAULT_PRINT_SETTINGS, template: 'delivery-note' as const, rowsPerPage: 5, offsetX: 0, offsetY: 5 }; }
};

export default function DotMatrixPrint({ document: selectedDocument, loading = false, blocked = false }: { document?: PrintDocument; loading?: boolean; blocked?: boolean }) {
  const [settings, setSettings] = useState<DotMatrixSettings>(readSettings);
  const [showSample, setShowSample] = useState(false);
  const [advanced, setAdvanced] = useState(false);
  const [loadedHtml, setLoadedHtml] = useState('');
  const [layout, setLayout] = useState({ pages: 0, height: 540 });
  const [previewError, setPreviewError] = useState('');
  const [message, setMessage] = useState('');
  const [storageError, setStorageError] = useState(false);
  const [availableWidth, setAvailableWidth] = useState(300);
  const [expandedPreview, setExpandedPreview] = useState(false);
  const [previewZoom, setPreviewZoom] = useState(1);
  const [expandedHeight, setExpandedHeight] = useState(540);
  const [editing, setEditing] = useState(false);
  const [editedDoc, setEditedDoc] = useState<PrintDocument | null>(null);
  const bridge = useMemo(getLocalPrintBridge, []);
  const [printers, setPrinters] = useState<LocalPrinter[]>([]);
  const [printerName, setPrinterName] = useState(() => {
    try { const saved = Taro.getStorageSync(PRINTER_KEY); return typeof saved === 'string' ? saved : ''; } catch { return ''; }
  });
  const [printersLoading, setPrintersLoading] = useState(!!bridge);
  const [printerError, setPrinterError] = useState('');
  const [printing, setPrinting] = useState(false);
  const printerRead = useMemo(() => ({ generation: 0 }), []);
  const printBusy = useRef(false);
  const printAttempt = useRef<{ fingerprint: string; id: string } | null>(null);
  const stage = useRef<HTMLDivElement>(null);
  const frame = useRef<HTMLIFrameElement>(null);
  const printCleanup = useRef<(() => void) | null>(null);
  const sample = useMemo(samplePrintDocument, []);
  const originalDoc = !selectedDocument || showSample ? sample : selectedDocument;
  const doc = editedDoc || originalDoc;
  // 渲染模板抛错（如预印超行）时不得让整个打印中心崩溃：降级为错误提示。
  const { html, buildError } = useMemo(() => {
    try { return { html: buildDotMatrixHtml(doc, settings), buildError: '' }; }
    catch (error) { return { html: '', buildError: error instanceof Error ? error.message : '单据无法排版，请调整内容后重试' }; }
  }, [doc, settings]);
  const width = settings.width * 96 / 25.4 + 24;
  const scale = Math.min(1, Math.max(0.1, (availableWidth - 24) / width));
  const native = typeof window !== 'undefined' && !!(window as any).Capacitor?.isNativePlatform?.();
  const ready = loadedHtml === html && !previewError && !loading && !blocked;
  const selectedPrinter = printers.find(printer => printer.name === printerName);
  const localReady = !bridge || (!printersLoading && !printerError && !!selectedPrinter && !selectedPrinter.unavailable);

  const refreshPrinters = useCallback(async () => {
    if (!bridge) return;
    const request = ++printerRead.generation;
    setPrintersLoading(true); setPrinterError('');
    try {
      const items = await bridge.listPrinters();
      if (request !== printerRead.generation) return;
      setPrinters(items);
      // A previously selected missing/offline printer must never silently become another device.
      setPrinterName(previous => previous || items.find(item => item.isDefault && !item.unavailable)?.name || items.find(item => !item.unavailable)?.name || '');
    } catch (error) {
      if (request !== printerRead.generation) return;
      setPrinterError(error instanceof Error ? error.message : '读取打印机失败，请刷新重试');
    } finally { if (request === printerRead.generation) setPrintersLoading(false); }
  }, [bridge, printerRead]);

  useEffect(() => {
    void refreshPrinters();
    return () => { printerRead.generation++; };
  }, [refreshPrinters, printerRead]);
  useEffect(() => {
    if (bridge && printerName) { try { Taro.setStorageSync(PRINTER_KEY, printerName); } catch { /* Current selection still works. */ } }
  }, [bridge, printerName]);

  useEffect(() => { setShowSample(false); setMessage(''); setEditedDoc(null); setEditing(false); }, [selectedDocument]);
  useEffect(() => {
    try { Taro.setStorageSync(STORAGE_KEY, settings); setStorageError(false); }
    catch { setStorageError(true); }
  }, [settings]);
  useEffect(() => {
    const container = stage.current;
    if (!container) return;
    const resize = () => setAvailableWidth(container.getBoundingClientRect().width);
    resize();
    if (typeof ResizeObserver !== 'undefined') {
      const observer = new ResizeObserver(resize); observer.observe(container);
      return () => observer.disconnect();
    }
    window.addEventListener('resize', resize);
    return () => window.removeEventListener('resize', resize);
  }, []);
  useEffect(() => {
    if (!expandedPreview) return;
    const closeOnEscape = (event: KeyboardEvent) => {
      if (event.key === 'Escape') setExpandedPreview(false);
    };
    window.addEventListener('keydown', closeOnEscape);
    return () => window.removeEventListener('keydown', closeOnEscape);
  }, [expandedPreview]);

  useEffect(() => {
    if (typeof window === 'undefined') return;
    const clear = () => { printCleanup.current?.(); printCleanup.current = null; };
    const beforePrint = () => {
      if (native || !ready || printCleanup.current || !stage.current?.getClientRects().length) return;
      const content = frame.current?.contentDocument;
      if (!content) return;
      try { printCleanup.current = mountDotMatrixPrintDocument(content, settings, window.document); }
      catch (error) { setMessage(error instanceof Error ? error.message : '打印排版失败，请重试'); }
    };
    window.addEventListener('beforeprint', beforePrint);
    window.addEventListener('afterprint', clear);
    return () => {
      window.removeEventListener('beforeprint', beforePrint);
      window.removeEventListener('afterprint', clear);
      clear();
    };
  }, [native, ready, settings, html]);

  const update = (patch: Partial<DotMatrixSettings>) => {
    setSettings(previous => normalizePrintSettings({ ...previous, ...patch }));
    setMessage('');
  };
  const onLoad = async () => {
    const element = frame.current;
    const content = element?.contentDocument;
    if (!content || element?.srcdoc !== html) return;
    try {
      await content.fonts?.ready;
      if (frame.current !== element || element.srcdoc !== html || element.contentDocument !== content) return;
      const result = paginateDotMatrixDocument(content, doc, settings);
      setLayout(result); setPreviewError(''); setLoadedHtml(html);
    } catch (error) {
      if (frame.current !== element) return;
      setPreviewError(error instanceof Error ? error.message : '预览排版失败，请重试'); setLoadedHtml('');
    }
  };
  const onExpandedLoad = async (element: HTMLIFrameElement) => {
    const content = element.contentDocument;
    if (!content || element.srcdoc !== html) return;
    try {
      await content.fonts?.ready;
      if (element.srcdoc !== html || !element.isConnected) return;
      const result = paginateDotMatrixDocument(content, doc, settings);
      setExpandedHeight(result.height);
    } catch (error) {
      setPreviewError(error instanceof Error ? error.message : '放大预览排版失败，请重试');
    }
  };
  const print = async () => {
    if (!ready || !localReady || printBusy.current) return;
    if (bridge) {
      if (!selectedPrinter) return;
      printBusy.current = true; setPrinting(true); setMessage('');
      const fingerprint = JSON.stringify({ printerName, document: doc, settings });
      if (printAttempt.current?.fingerprint !== fingerprint) printAttempt.current = {
        fingerprint, id: `print-${Date.now()}-${Array.from(crypto.getRandomValues(new Uint32Array(4))).map(value => value.toString(16)).join('-')}`,
      };
      try {
        const result = await bridge.print({ id: printAttempt.current.id, printerName, document: doc, settings });
        if (result.kind === 'pdf' && result.pdf) {
          downloadPrintPdf(result.pdf, doc.number);
          setMessage(`已生成 ${doc.number} 的 PDF，共 ${result.pages} 页。`);
        } else {
          setMessage(`已发送「${doc.number}」到 ${result.printerName}，共 ${result.pages} 页、1 份。实际出纸请以打印机为准。`);
        }
        printAttempt.current = null;
      } catch (error) {
        if ((error as { safeToRetry?: boolean })?.safeToRetry) printAttempt.current = null;
        setMessage(error instanceof Error ? error.message : '本机打印失败，请检查打印机连接');
      } finally { printBusy.current = false; setPrinting(false); }
      return;
    }
    try {
      const content = frame.current?.contentDocument;
      if (native || !content || typeof window.print !== 'function') throw new Error('请在连接针式打印机的电脑浏览器或 Windows 客户端打开此单据');
      printCleanup.current?.();
      printCleanup.current = mountDotMatrixPrintDocument(content, settings, window.document);
      window.print();
      setMessage(`已调用系统打印窗口。请核对纸张 ${settings.width} × ${settings.height} mm、比例 100%，并关闭页眉页脚；实际出纸请以打印机为准。`);
    } catch (error) {
      printCleanup.current?.(); printCleanup.current = null;
      setMessage(error instanceof Error ? error.message : '无法打开打印窗口，请在电脑浏览器重试');
    }
  };

  return <View className={styles.panel}>
    <View className={styles.heading}><View><Text className={styles.eyebrow}>DOT MATRIX / 连续纸单据</Text><Text className={styles.title}>针式打印</Text><Text className={styles.subtitle}>选好纸张，预览整单，再送入打印机。</Text></View><span className={styles.badge}>黑白 · 多联复写纸</span></View>
    {bridge && <div className={styles.printerSection}>
      <div className={styles.printerHeading}><div><strong>本机打印机</strong><span>直接点选下面的打印机</span></div><button data-print-control='button' type='button' className={styles.textButton} onClick={refreshPrinters} disabled={printersLoading || printing}>{printersLoading ? '读取打印机中…' : '刷新打印机'}</button></div>
      <div className={styles.printers} role='radiogroup' aria-label='目标打印机'>
        {printers.map(printer => <label data-print-control='label' key={printer.name} className={`${styles.printerCard} ${printer.name === printerName ? styles.printerChosen : ''}`}>
          <input data-print-control='radio' type='radio' name='dot-matrix-printer' value={printer.name} checked={printer.name === printerName} onChange={() => { setPrinterName(printer.name); setMessage(''); }} disabled={printing || printersLoading} />
          <span><strong>{printer.displayName}</strong><small>{printer.offline ? '离线 · 请检查连接' : printer.unavailable ? '设备暂不可用' : printer.isPdf ? '保存为 PDF 文件' : '可用'}{printer.isDefault ? ' · 系统默认' : ''}</small></span>
        </label>)}
      </div>
      {printerError && <p className={styles.error} role='alert'>{printerError}</p>}
      {!printersLoading && !printerError && !printers.length && <p className={styles.error}>尚未发现打印机，请连接设备并安装驱动后刷新。</p>}
      {!printersLoading && printers.length > 0 && !selectedPrinter && <p className={styles.error}>上次使用的打印机不可用，请重新选择。</p>}
      {selectedPrinter && <p className={selectedPrinter.unavailable ? styles.error : styles.printerSelected} data-selected-printer={selectedPrinter.name}>{selectedPrinter.unavailable ? `「${selectedPrinter.name}」当前不可用，请连接后刷新，或选择其他打印机。` : `当前选择：${selectedPrinter.name}${selectedPrinter.isPdf ? ' · 下载 PDF' : ' · 1 份 · 原始尺寸'}`}</p>}
    </div>}
    {(settings.template === 'outbound-four' || settings.template === 'delivery-note') && !loading && !blocked && <DocumentEditor key={originalDoc.number + String(showSample) + settings.template} inline rowsPerPage={settings.template === 'delivery-note' ? 5 : 4} document={doc} onCancel={() => {}} onSave={value => { setEditedDoc(value); setMessage(''); }} />}
    <div className={styles.workspace}>
      <div className={styles.controls}>
        <label data-print-control="label" className={styles.label}>纸张规格<span>宽 × 高，单位 mm</span></label>
        <label data-print-control="label" className={styles.label}>套打模板<span>已有印刷表格请选择套打</span></label>
        <div className={styles.papers}><button data-print-control='button' type='button' aria-pressed={settings.template === 'delivery-note'} className={settings.template === 'delivery-note' ? styles.chosen : ''} onClick={() => update({ template: 'delivery-note', paper: '241-93', width: 241, height: 93, rowsPerPage: 5 })}><strong>三等分送货单</strong><span>按 Excel 模板 · 5 行明细</span></button><button data-print-control='button' type='button' aria-pressed={settings.template === 'outbound-four'} className={settings.template === 'outbound-four' ? styles.chosen : ''} onClick={() => update({ template: 'outbound-four', paper: '241-93', width: 241, height: 93, rowsPerPage: 4 })}><strong>四格出库单</strong><span>三等分纸 · 内容可编辑</span></button><button data-print-control="button" type='button' aria-pressed={settings.template === 'blank'} className={settings.template === 'blank' ? styles.chosen : ''} onClick={() => update({ template: 'blank' })}><strong>空白连续纸</strong><span>通用单据</span></button><button data-print-control="button" type='button' aria-pressed={settings.template === 'preprinted-outbound'} className={settings.template === 'preprinted-outbound' ? styles.chosen : ''} onClick={() => update({ template: 'preprinted-outbound', paper: '241-140', width: 241, height: 140, rowsPerPage: 6 })}><strong>预印出库单</strong><span>二等分套打内容</span></button></div>
        <div className={styles.papers}>{PAPER_PRESETS.map(preset => <button data-print-control="button" type='button' key={preset.id} aria-pressed={settings.paper === preset.id} disabled={settings.template !== 'blank' && !((settings.template === 'outbound-four' || settings.template === 'delivery-note') && preset.id === '241-93') && !(settings.template === 'preprinted-outbound' && preset.id === '241-140')} className={settings.paper === preset.id ? styles.chosen : ''} onClick={() => update({ paper: preset.id })}><strong>{preset.name}</strong><span>{preset.detail}</span></button>)}</div>
        <button data-print-control="button" className={styles.textButton} type='button' aria-pressed={settings.paper === 'custom'} onClick={() => update({ paper: 'custom' })}>自定义纸张尺寸 {settings.paper === 'custom' ? '✓' : '＋'}</button>
        {settings.paper === 'custom' && <div className={styles.fields}><label data-print-control="label">纸宽（mm）<input data-print-control="input" aria-label='纸宽（mm）' type='number' min='180' max='300' step='0.1' defaultValue={settings.width} onBlur={event => { update({ width: Number(event.target.value) }); event.target.value = String(normalizePrintSettings({ ...settings, width: Number(event.target.value) }).width); }} /></label><label data-print-control="label">纸高（mm）<input data-print-control="input" aria-label='纸高（mm）' type='number' min='80' max='400' step='0.1' defaultValue={settings.height} onBlur={event => { update({ height: Number(event.target.value) }); event.target.value = String(normalizePrintSettings({ ...settings, height: Number(event.target.value) }).height); }} /></label></div>}
        {settings.template === 'blank' && <label data-print-control="label" className={styles.label}>打印抬头<input data-print-control="input" aria-label='打印抬头' maxLength={50} defaultValue={settings.company} onInput={event => update({ company: event.currentTarget.value })} placeholder='填写公司或工厂名称' /></label>}
        {(settings.template === 'outbound-four' || settings.template === 'delivery-note') && <label data-print-control='label' className={styles.label}>单据标题<input data-print-control='input' aria-label='单据标题' maxLength={60} value={settings.formTitle} onChange={event => update({ formTitle: event.currentTarget.value })} /></label>}
        <label data-print-control='label' className={styles.checkbox}><input data-print-control='input' type='checkbox' checked={settings.highClarity} onChange={event => update({ highClarity: event.target.checked })} />清晰无衬线字体</label>
        {settings.highClarity && <p className={styles.note}>无衬线正文 · {settings.fontSize} pt</p>}
        <label data-print-control="label" className={styles.checkbox}><input data-print-control="input" type='checkbox' checked={settings.showPrices} onChange={event => update({ showPrices: event.target.checked })} />显示单价和金额</label>
        <button data-print-control="button" className={styles.advancedToggle} type='button' aria-expanded={advanced} onClick={() => setAdvanced(!advanced)}>排版与位置校准 <span>{advanced ? '收起 −' : '展开 ＋'}</span></button>
        {advanced && <div className={styles.advanced}>
          <div className={styles.fields}><label data-print-control="label">字号<select data-print-control="select" aria-label='字号' value={settings.fontSize} onChange={event => update({ fontSize: Number(event.target.value) })}>{(settings.highClarity ? [10, 11, 12] : [9, 10, 11, 12]).map(size => <option value={size} key={size}>{size} pt</option>)}</select></label><label data-print-control="label">每页最多明细<select data-print-control="select" aria-label='每页最多明细' value={settings.rowsPerPage} disabled={settings.template !== 'blank'} onChange={event => update({ rowsPerPage: Number(event.target.value) })}>{Array.from({ length: 20 }, (_, i) => i + 1).map(count => <option value={count} key={count}>{count} 行</option>)}</select></label></div>
          <div className={styles.fields}>{(['offsetX', 'offsetY'] as const).map(key => <label data-print-control="label" key={key}>{key === 'offsetX' ? '左右偏移' : '上下偏移'}（mm）<input data-print-control="input" aria-label={key === 'offsetX' ? '左右偏移（mm）' : '上下偏移（mm）'} type='number' min='-5' max='5' step='0.5' key={settings[key]} defaultValue={settings[key]} onBlur={event => update({ [key]: Number(event.target.value) })} /></label>)}</div>
          <p className={styles.note}>正数向右／下移动，负数向左／上移动。长明细自动换行，放不下时自动续页。</p>
          <button data-print-control="button" className={styles.textButton} type='button' onClick={() => update({ offsetX: 0, offsetY: 0 })}>偏移归零</button>
        </div>}
        <div className={styles.instructions}><strong>打印参数</strong><p>{settings.width} × {settings.height} mm · 100% · 1份</p><p>{settings.template === 'preprinted-outbound' ? '预印纸套打：只打印字段内容。' : settings.template === 'delivery-note' ? '按三等分送货单模板打印，包含 5 行明细。' : '空白纸打印：包含标题、表头、格线和签字栏。'}</p></div>
        <span className={styles.saved}>{storageError ? '本次设置有效，当前设备无法保存设置' : '纸张和校准设置自动保存在本机'}</span>
      </div>
      <div className={styles.previewPanel}>
        <div className={styles.previewHeader}><div><strong>{doc.sample ? '测试样张' : doc.number}</strong><span>{loading ? '正在读取完整单据…' : doc.sample ? '仅用于检查走纸，不生成业务记录' : `${doc.party} · ${doc.lines.length} 条明细`}</span></div><span className={styles.pageCount}>{previewError ? '待调整' : loadedHtml === html ? `${layout.pages} 页` : '排版中'}</span></div>
        <div className={styles.stage} ref={stage}><div className={styles.frameShell} style={{ width: width * scale, height: layout.height * scale }}><iframe key={html} ref={frame} title='针式单据打印预览' sandbox='allow-same-origin allow-modals' srcDoc={html} onLoad={onLoad} style={{ width, height: layout.height, transform: `scale(${scale})` }} /></div></div>
        {buildError && <p className={styles.error} role='alert'>{buildError}</p>}
        {previewError && <p className={styles.error} role='alert'>{previewError}</p>}
        <div className={styles.previewFooter}><span>{settings.width} × {settings.height} mm · {settings.fontSize} pt{settings.highClarity ? ' · 清晰正文' : ''} · 自动分页</span><button data-print-control='button' className={styles.previewExpand} type='button' disabled={!ready} onClick={() => { setExpandedHeight(layout.height); setPreviewZoom(1); setExpandedPreview(true); }}>放大查看文字</button></div>
        <div className={styles.actions}>{selectedDocument && <button data-print-control="button" className={styles.secondary} type='button' disabled={loading || printing} onClick={() => { setShowSample(!showSample); setEditedDoc(null); setMessage(''); }}>{showSample ? '返回所选单据' : '查看测试样张'}</button>}{editedDoc && <button data-print-control='button' className={styles.textButton} type='button' disabled={printing} onClick={() => setEditedDoc(null)}>恢复原单内容</button>}<button data-print-control="button" className={styles.primary} type='button' disabled={!ready || native || !localReady || printing} onClick={print}>{printing ? '正在发送…' : blocked ? '单据暂不可打印' : loading ? '加载单据中…' : bridge && selectedPrinter?.isPdf ? '保存本单 PDF' : doc.sample ? '打印测试样张' : `打印本单 · ${loadedHtml === html ? layout.pages : '…'} 页`}</button></div>
        {native && <p className={styles.note}>手机端可查看预览；请在连接针式打印机的电脑上打开同一张单据进行打印。</p>}
        {message && <p className={styles.status} role='status'>{message}</p>}
      </div>
    </div>
    {editing && <DocumentEditor document={doc} onCancel={() => setEditing(false)} onSave={value => { setEditedDoc(value); setEditing(false); setMessage('本次打印内容已更新'); }} />}
    {expandedPreview && typeof document !== 'undefined' && createPortal(
      <div className={styles.expandedBackdrop} role='presentation' onClick={event => { if (event.target === event.currentTarget) setExpandedPreview(false); }}>
        <div className={styles.expandedDialog} role='dialog' aria-modal='true' aria-label='放大查看测试样张'>
          <div className={styles.expandedToolbar}>
            <div><strong>{doc.sample ? '测试样张' : doc.number}</strong><span>{settings.width} × {settings.height} mm · 仅放大屏幕预览，不改变打印尺寸</span></div>
            <div className={styles.zoomControls}>
              <button type='button' aria-label='缩小预览' disabled={previewZoom <= 1} onClick={() => setPreviewZoom(previous => Math.max(1, previous - 0.25))}>−</button>
              <span aria-label='当前预览倍率'>{Math.round(previewZoom * 100)}%</span>
              <button type='button' aria-label='放大预览' disabled={previewZoom >= 1.5} onClick={() => setPreviewZoom(previous => Math.min(1.5, previous + 0.25))}>＋</button>
              <button type='button' className={styles.closePreview} aria-label='关闭放大预览' onClick={() => setExpandedPreview(false)}>关闭</button>
            </div>
          </div>
          <p className={styles.zoomHint}>原尺寸文字预览；窗口较窄时可横向滚动查看整张单据。</p>
          <div className={styles.expandedStage}>
            <div className={styles.frameShell} style={{ width: width * previewZoom, height: expandedHeight * previewZoom }}>
              <iframe key={html} title='放大的针式单据预览' sandbox='allow-same-origin' srcDoc={html} onLoad={event => { void onExpandedLoad(event.currentTarget); }} style={{ width, height: expandedHeight, transform: `scale(${previewZoom})` }} />
            </div>
          </div>
        </div>
      </div>, document.body)}
  </View>;
}
