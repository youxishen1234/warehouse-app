/* eslint-disable react/forbid-elements */
import { useEffect, useState } from 'react';
import { createPortal } from 'react-dom';
import type { PrintDocument, PrintLine } from '@/utils/dot-matrix-print';
import styles from './index.module.scss';

type LineDraft = { source: PrintLine; code: string; name: string; specification: string; unit: string; quantity: string; price: string; amount: string; remark: string };
const headerFields = [['party', '单位'], ['date', '日期'], ['formNumber', '单号 No'], ['category', '类别'], ['orderNumber', '编号'], ['address', '收件地址'], ['phone', '联系电话'], ['receiver', '收货人'], ['supervisor', '主管'], ['warehouse', '仓库'], ['accountant', '记账'], ['operator', '经手人']] as const;
const lineFields = [['code', '编号'], ['name', '名称'], ['specification', '规格'], ['unit', '单位'], ['quantity', '出库数量'], ['price', '单价'], ['amount', '金额'], ['remark', '备注']] as const;
const emptyDraft = (index: number, type: PrintLine['type']): LineDraft => ({ source: { id: 1000000 + index, product_id: 0, type, quantity: 0, created_at: 0, operator: '', remark: '', blank: true }, code: '', name: '', specification: '', unit: '', quantity: '', price: '', amount: '', remark: '' });

export default function DocumentEditor({ document: source, onSave, onCancel, inline = false, rowsPerPage = 4 }: { inline?: boolean; rowsPerPage?: number; document: PrintDocument; onSave: (value: PrintDocument) => void; onCancel: () => void }) {
  const [header, setHeader] = useState(() => Object.fromEntries(headerFields.map(([key]) => [key, key === 'formNumber' ? source.formNumber || source.number : source[key] || ''])) as Record<(typeof headerFields)[number][0], string>);
  const [lines, setLines] = useState<LineDraft[]>(() => {
    const drafts = source.lines.map((line, index) => line.blank ? emptyDraft(index, line.type) : ({ source: { ...line }, code: line.printCode ?? String(line.product_id), name: line.product_name || '', specification: line.specification || '', unit: line.unit || '', quantity: String(line.quantity), price: line.unit_price == null ? '' : String(line.unit_price), amount: line.amount == null ? '' : line.amount.toFixed(2), remark: line.remark || '' }));
    while (drafts.length < Math.max(rowsPerPage, Math.ceil(source.lines.length / rowsPerPage) * rowsPerPage)) drafts.push(emptyDraft(drafts.length, source.lines[0]?.type || 'out'));
    return drafts;
  });
  const [page, setPage] = useState(0);
  const [error, setError] = useState('');
  useEffect(() => {
    const escape = (event: KeyboardEvent) => { if (event.key === 'Escape') onCancel(); };
    window.addEventListener('keydown', escape);
    return () => window.removeEventListener('keydown', escape);
  }, [onCancel]);
  const changeLine = (index: number, key: keyof Omit<LineDraft, 'source'>, value: string) => {
    setLines(previous => previous.map((row, position) => {
      if (position !== index) return row;
      const next = { ...row, [key]: value };
      if ((key === 'quantity' || key === 'price') && next.quantity.trim() && next.price.trim()) {
        const quantity = Number(next.quantity), price = Number(next.price);
        if (Number.isFinite(quantity) && Number.isFinite(price) && quantity >= 0 && price >= 0) next.amount = (Math.round(quantity * price * 100) / 100).toFixed(2);
      }
      return next;
    }));
    setError('');
  };
  const save = () => {
    try {
      const numeric = (value: string, row: number, label: string, required = false): number | undefined => {
        if (!value.trim()) { if (required) throw new Error(`第 ${row} 行请填写${label}`); return undefined; }
        const number = Number(value);
        if (!Number.isFinite(number) || number < 0 || number > 1e12) throw new Error(`第 ${row} 行${label}须为有效非负数`);
        return number;
      };
      const nextLines = lines.map((row, index): PrintLine => {
        const blank = lineFields.every(([key]) => !row[key].trim());
        if (blank) return { ...row.source, blank: true, printCode: '', quantity: 0, product_name: '', specification: '', unit: '', unit_price: undefined, amount: undefined, remark: '' };
        return { ...row.source, blank: false, printCode: row.code, product_name: row.name, specification: row.specification, unit: row.unit, quantity: numeric(row.quantity, index + 1, '出库数量', true)!, unit_price: numeric(row.price, index + 1, '单价'), amount: numeric(row.amount, index + 1, '金额'), remark: row.remark };
      });
      while (nextLines.length > rowsPerPage && nextLines.slice(-rowsPerPage).every(line => line.blank)) nextLines.splice(-rowsPerPage);
      onSave({ ...source, ...header, lines: nextLines });
    } catch (issue) { setError(issue instanceof Error ? issue.message : '请检查单据内容'); }
  };
  const content = <div className={inline ? styles.inlineEditor : styles.expandedBackdrop}>
    <div className={`${styles.expandedDialog} ${styles.editorDialog}`} role={inline ? 'region' : 'dialog'} aria-modal={inline ? undefined : true} aria-label={`编辑${rowsPerPage}行出库单`} onBlur={inline ? event => { if (event.target instanceof HTMLInputElement) save(); } : undefined}>
      <div className={styles.expandedToolbar}><div><strong>{inline ? '直接填写出库单' : '编辑出库单'}</strong><span>{inline ? '点击下方内容修改，填完即可打印' : '仅修改本次打印内容'}</span></div>{!inline && <div className={styles.zoomControls}><button data-print-control='button' type='button' aria-label='取消编辑' onClick={onCancel}>取消</button><button data-print-control='button' type='button' className={styles.editorSave} onClick={save}>应用到预览</button></div>}</div>
      <div className={styles.editorBody}>
        <div className={styles.editorFields}>{headerFields.filter(([key]) => rowsPerPage !== 5 || ['party', 'date', 'address', 'phone', 'receiver', 'operator'].includes(key)).map(([key, label]) => <label data-print-control='label' key={key}>{rowsPerPage === 5 && key === 'party' ? '收货单位' : rowsPerPage === 5 && key === 'operator' ? '送货人' : label}<input data-print-control='input' aria-label={label} value={header[key]} maxLength={100} onChange={event => setHeader(previous => ({ ...previous, [key]: event.target.value }))} /></label>)}</div>
        <div className={styles.editorPage}><label data-print-control='label'>明细页<select data-print-control='select' aria-label='编辑明细页' value={page} onChange={event => setPage(Number(event.target.value))}>{Array.from({ length: lines.length / rowsPerPage }, (_, index) => <option key={index} value={index}>第 {index + 1} 页</option>)}</select></label><span>每页 {rowsPerPage} 行</span><button data-print-control='button' type='button' onClick={() => { setLines(previous => [...previous, ...Array.from({ length: rowsPerPage }, (_, index) => emptyDraft(previous.length + index, source.lines[0]?.type || 'out'))]); setPage(lines.length / rowsPerPage); }}>添加一页</button></div>
        <div className={styles.editorTable}><table><thead><tr><th>行</th>{lineFields.map(([key, label]) => <th key={key}>{label}</th>)}</tr></thead><tbody>{lines.slice(page * rowsPerPage, page * rowsPerPage + rowsPerPage).map((row, position) => {
          const index = page * rowsPerPage + position;
          return <tr key={index}><th>{position + 1}</th>{lineFields.map(([key, label]) => <td key={key}><input data-print-control='input' aria-label={`第${index + 1}行${label}`} inputMode={['quantity', 'price', 'amount'].includes(key) ? 'decimal' : 'text'} value={row[key]} maxLength={key === 'remark' ? 250 : 100} onChange={event => changeLine(index, key, event.target.value)} /></td>)}</tr>;
        })}</tbody></table></div>
        {error && <p role='alert' className={styles.error}>{error}</p>}
      </div>
    </div>
  </div>;
  return inline ? content : createPortal(content, window.document.body);
}
