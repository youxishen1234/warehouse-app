import { request } from './request';
import type { PageResult } from '@/types';
import type { PrintNoteInput, SavedPrintNote } from '../../backend/print-notes';
export type { PrintNoteInput, SavedPrintNote, PrintNoteItem } from '../../backend/print-notes';
export const getPrintNotes = (keyword = '', page = 1) => request<PageResult<SavedPrintNote>>({ url: `/api/print-notes?keyword=${encodeURIComponent(keyword)}&page=${page}&page_size=30` });
export const getPrintNote = (id: number) => request<SavedPrintNote>({ url: `/api/print-notes/${id}` });
export const savePrintNote = (data: PrintNoteInput, previous?: SavedPrintNote) => request<SavedPrintNote>({
  url: previous ? `/api/print-notes/${previous.id}` : '/api/print-notes',
  method: previous ? 'PUT' : 'POST', data: { ...data, ...(previous ? { version: previous.version } : {}) },
});
export const shipPrintNote = (id: number) => request<SavedPrintNote>({ url: `/api/print-notes/${id}/ship`, method: 'POST', data: {} });
