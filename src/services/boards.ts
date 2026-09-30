import { request } from './request';
export interface BoardMovement { id: string; batchId: string; type: 'in' | 'out' | 'count'; quantity: number; balance: number; before?: number; recipient?: string; remark: string; createdAt: number; date?: string }
export interface BoardBatch {
  id: string; specKey: string; supplier: string; boardLength: number; boardWidth: number; fluteType: string; layers: number; faceGsm: number; linerGsm: number; flutingGsm: number; cartonLength: number; cartonWidth: number; cartonHeight: number; orderedQty: number; receivedQty: number; remainingQty: number; giftQty: number; shortageQty: number; billedArea: number; unitPrice: number; amount: number; date: string; deliveryNo: string; location: string; remark: string; warningQty: number; createdAt: number; movements: BoardMovement[];
}
export const getBoards = () => request<BoardBatch[]>({ url: '/api/boards' });
export const getBoard = (id: string) => request<BoardBatch>({ url: `/api/boards/${encodeURIComponent(id)}` });
export const receiveBoard = (data: Record<string, string | number>) => request<BoardBatch>({ url: '/api/boards', method: 'POST', data });
export const moveBoard = (id: string, data: { type: 'out' | 'count'; quantity: number; remark: string; recipient: string }) => request<BoardBatch>({ url: `/api/boards/${encodeURIComponent(id)}/movements`, method: 'POST', data });
export const boardSpec = (b: BoardBatch) => `${b.boardLength} × ${b.boardWidth}`;
export const cartonSpec = (b: BoardBatch) => `${b.cartonLength} × ${b.cartonWidth} × ${b.cartonHeight}`;
export const today = () => { const d = new Date(); return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`; };
export const boardLink = (id: string) => `https://youxishen.online/pages/board-detail/index?id=${encodeURIComponent(id)}`;
export function parseBoardCode(raw: string) {
  let id = raw.trim();
  if (id.startsWith('https://youxishen.online/')) { const url = new URL(id); id = (url.hash ? new URLSearchParams(url.hash.split('?')[1] || '') : url.searchParams).get('id') || ''; }
  if (!/^BOARD-[0-9]{8}-[A-F0-9]{12}$/.test(id)) throw new Error('这不是纸板批次标签，请扫描入库后生成的二维码');
  return id;
}
