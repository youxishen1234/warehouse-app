import type { Customer, Transaction } from '@/types';
import type { PrintNoteInput, SavedPrintNote } from '@/services/print-notes';
import { normalizeSpecification, validateNote } from '../../../backend/print-notes';
import { localDate, previewAmount } from '@/utils/stock-math';
import { DEFAULT_PRINT_SETTINGS, normalizePrintSettings } from '@/utils/dot-matrix-print';
import type { PrintDocument } from '@/utils/dot-matrix-print';
export { normalizeSpecification };
export type ItemDraft = { key: string; product_id: number | null; name: string; specification: string; quantity: string; price: string; remark: string };
export type NoteDraft = Omit<PrintNoteInput, 'items' | 'total'> & { items: ItemDraft[] };
let sequence = 0;
export const blankItem = (): ItemDraft => ({ key: `item-${++sequence}`, product_id: null, name: '', specification: '', quantity: '', price: '', remark: '' });
export const newNote = (): NoteDraft => ({ company: '东光县曙光纸箱包装', customer_id: null, customer_name: '', address: '', phone: '', receiver: '', sender: '', date: localDate(), paper: '241-93', items: [blankItem()] });
export const noteDraft = (note: PrintNoteInput): NoteDraft => ({ ...note, items: note.items.map(item => ({ ...blankItem(), product_id: item.product_id ?? null, name: item.name, specification: item.specification, quantity: String(item.quantity), price: String(item.price), remark: item.remark })) });
export const selectCustomer = (draft: NoteDraft, customer: Customer): NoteDraft => ({ ...draft, customer_id: customer.id, customer_name: customer.name, address: customer.address || '', phone: customer.phone || '', receiver: customer.contact || '' });
export const draftTotal = (draft: NoteDraft) => draft.items.reduce((sum, item) => sum + Math.round(previewAmount(item.quantity, item.price) * 100), 0) / 100;
export const validateDraft = (draft: NoteDraft): PrintNoteInput => validateNote(draft);
export const printSettings = (note: Pick<PrintNoteInput, 'company' | 'paper'>) => normalizePrintSettings({ ...DEFAULT_PRINT_SETTINGS, template: 'delivery-note', company: note.company, paper: note.paper, offsetX: 0, offsetY: 0 });
export function printDocument(note: PrintNoteInput, saved?: SavedPrintNote): PrintDocument {
  return { key: `delivery-${saved?.id || 'draft'}`, number: saved?.number || '送货单预览', title: '送 货 单',
    party: note.customer_name, address: note.address, phone: note.phone, receiver: note.receiver, date: note.date, operator: note.sender, orderNumber: '',
    lines: note.items.map((item, index) => ({ id: index + 1, product_id: item.product_id || 0, type: 'out', created_at: 0, operator: note.sender, product_name: item.name,
      specification: normalizeSpecification(item.specification), unit: '个', quantity: item.quantity, unit_price: item.price, amount: item.amount, remark: item.remark })) };
}
export function draftFromTransactions(records: Transaction[], customer?: Customer): NoteDraft {
  const first = records[0];
  const date = new Date(first.created_at);
  return { ...newNote(), customer_id: first.type === 'out' ? first.customer_id || null : null,
    customer_name: first.customer_name || first.supplier_name || '', address: customer?.address || '', phone: customer?.phone || '', receiver: customer?.contact || '',
    sender: first.operator || '', date: Number.isNaN(date.getTime()) ? localDate() : localDate(date),
    items: records.map(item => ({ ...blankItem(), name: item.product_name || '', specification: normalizeSpecification(item.specification), quantity: String(item.quantity), price: item.unit_price == null ? '' : String(item.unit_price), remark: item.remark || '' })) };
}
