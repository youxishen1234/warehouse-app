/* eslint-disable react/forbid-elements */
import { useEffect, useMemo, useRef, useState } from 'react';
import type { PrintNoteInput } from '@/services/print-notes';
import { buildDotMatrixHtml, paginateDotMatrixDocument } from '@/utils/dot-matrix-print';
import { printDocument, printSettings } from './model';
import styles from './index.module.scss';

export default function PrintPaper({ note, showPrices, onExpand }: {
  note?: PrintNoteInput;
  showPrices: boolean;
  onExpand: () => void;
}) {
  const stage = useRef<HTMLDivElement>(null);
  const [available, setAvailable] = useState(300);
  const [height, setHeight] = useState(380);
  const settings = useMemo(() => note ? { ...printSettings(note), showPrices } : undefined, [note, showPrices]);
  const document = useMemo(() => note ? printDocument(note) : undefined, [note]);
  const html = useMemo(() => document && settings ? buildDotMatrixHtml(document, settings) : '', [document, settings]);
  useEffect(() => {
    const element = stage.current;
    if (!element) return;
    const resize = () => setAvailable(element.clientWidth);
    resize();
    const observer = new ResizeObserver(resize);
    observer.observe(element);
    return () => observer.disconnect();
  }, []);
  const width = settings ? settings.width * 96 / 25.4 + 24 : 1;
  const scale = Math.min(1, available / width);
  return <div className={styles.demoPaper} ref={stage}>
    {note && document && settings ? <button type='button' aria-label='放大单据预览' className={styles.demoPaperButton} onClick={onExpand}>
      <span style={{ display: 'block', position: 'relative', width: width * scale, height: height * scale, overflow: 'hidden' }}>
        <iframe title='当前单据预览' sandbox='allow-same-origin' srcDoc={html} tabIndex={-1}
          onLoad={event => { const content = event.currentTarget.contentDocument; if (content) setHeight(paginateDotMatrixDocument(content, document, settings).height); }}
          style={{ position: 'absolute', top: 0, left: 0, width, height, border: 0, transform: `scale(${scale})`, transformOrigin: 'top left', pointerEvents: 'none' }} />
      </span>
    </button> : <div className={styles.demoPaperEmpty}><PrintEmptyIcon /><span>暂无可预览单据</span></div>}
  </div>;
}

function PrintEmptyIcon() {
  return <svg width='34' height='34' viewBox='0 0 24 24' fill='none' stroke='currentColor' strokeWidth='1.3' aria-hidden='true'><path d='M6 3h9l4 4v14H6zM14 3v5h5M9 12h7M9 16h5' /></svg>;
}
