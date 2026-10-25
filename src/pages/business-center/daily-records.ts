import type { LedgerEntry, Transaction } from '@/types';
import type { BoardBatch } from '@/services/boards';
import type { ProductionRecord } from '@/services/business-workflow';

export type DailyRecord = {
  id: string; title: string; detail: string; value: number; unit?: string; money: boolean;
  status: string; icon: 'package-plus' | 'factory' | 'truck' | 'wallet'; time: number;
  target: { board: string } | { ledger: number } | { records: true };
};
export const localDay = (time: number | Date) => {
  const date = new Date(time);
  return `${date.getFullYear()}-${date.getMonth() + 1}-${date.getDate()}`;
};

export type PartyMonthSummary = {
  monthSales: number;
  monthSettled: number;
};

const monthKey = (time: number) => {
  const date = new Date(time);
  return `${date.getFullYear()}-${date.getMonth() + 1}`;
};

// Sum this month's posted billing and cash settlement per party.  Linked
// receivable/payable rows are accruals and are counted as sales; they must not
// also be counted as money received or paid.  Voided rows are excluded so an
// edited or cancelled record never inflates the month.
// An explicit party_type is authoritative; only legacy rows without it are
// inferred from the ledger type.
export function partyMonthSummary(ledger: LedgerEntry[], supplier: boolean, now = new Date()): Map<number, PartyMonthSummary> {
  const result = new Map<number, PartyMonthSummary>();
  const key = monthKey(now.getTime());
  const partyType = supplier ? 'supplier' : 'customer';
  for (const entry of ledger) {
    if (entry.voided_at || entry.party_id == null || monthKey(entry.created_at) !== key) continue;
    const type = entry.party_type ?? (entry.type === 'receivable' ? 'customer' : entry.type === 'payable' ? 'supplier' : null);
    if (type !== partyType) continue;
    const row = result.get(Number(entry.party_id)) || { monthSales: 0, monthSettled: 0 };
    if (entry.type === 'settlement') row.monthSettled += Math.round(Number(entry.amount || 0) * 100);
    else if (entry.type === (supplier ? 'payable' : 'receivable')) row.monthSales += Math.round(Number(entry.amount || 0) * 100);
    result.set(Number(entry.party_id), row);
  }
  for (const row of result.values()) {
    row.monthSales /= 100;
    row.monthSettled /= 100;
  }
  return result;
}

// Display saved business data only; linked accruals must not duplicate receipts.
export function dailyRecords(data: { boards: BoardBatch[]; production: ProductionRecord[]; transactions: Transaction[]; ledger: LedgerEntry[] }, day: string): DailyRecord[] {
  const rows: DailyRecord[] = [];
  for (const b of data.boards) rows.push({ id: 'board-' + b.id, title: `${b.supplier} · 纸板入库`, detail: `${b.boardLength} × ${b.boardWidth} cm`, value: b.receivedQty, unit: '张', money: false, status: '已入库', icon: 'package-plus', time: b.createdAt, target: { board: b.id } });
  for (const p of data.production) rows.push({ id: 'production-' + p.id, title: `${p.product_name} · 生产单`, detail: p.specification, value: p.quantity, unit: p.unit, money: false, status: '已完工', icon: 'factory', time: p.created_at, target: { records: true } });
  for (const t of data.transactions) {
    if (t.voided_at || t.production_id) continue;
    const out = t.type === 'out', count = t.type === 'adjustment';
    const partyName = out ? t.customer_name : t.billing_source === 'production_inbound' ? t.customer_name : t.supplier_name;
    const linked = data.ledger.find(l => !l.voided_at && l.transaction_id === t.id);
    rows.push({ id: 'transaction-' + t.id, title: `${partyName || t.product_name || '商品'} · ${count ? '盘点单' : out ? '出库单' : '入库单'}`, detail: t.specification || t.product_name || t.remark, value: typeof t.amount === 'number' && !count ? t.amount : t.quantity, unit: t.unit, money: typeof t.amount === 'number' && !count, status: count ? '已盘点' : out ? '已出库' : '已入库', icon: out ? 'truck' : 'package-plus', time: t.created_at, target: linked ? { ledger: linked.id } : { records: true } });
  }
  for (const l of data.ledger) {
    if (l.voided_at || !['income', 'expense', 'settlement'].includes(l.type)) continue;
    const payment = l.type === 'expense' || (l.type === 'settlement' && l.party_type === 'supplier');
    const unknownSettlement = l.type === 'settlement' && !l.party_type;
    const label = unknownSettlement ? '结算' : payment ? '付款' : '收款';
    rows.push({ id: 'ledger-' + l.id, title: `${l.party_name || '日常账务'} · ${label}记录`, detail: l.remark || '已登记', value: l.amount, money: true, status: `已${label}`, icon: 'wallet', time: l.created_at, target: { ledger: l.id } });
  }
  return rows.filter(r => localDay(r.time) === day).sort((a, b) => b.time - a.time || a.id.localeCompare(b.id));
}
