import type { LedgerEntry, LedgerType } from '@/types';

export const ledgerTypes: { value: LedgerType | ''; label: string }[] = [
  { value: '', label: '全部' },
  { value: 'income', label: '收入' },
  { value: 'expense', label: '支出' },
  { value: 'receivable', label: '应收' },
  { value: 'payable', label: '应付' },
  { value: 'settlement', label: '结清' }
];

export function dateKey(date: Date): string {
  return `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, '0')}-${String(date.getDate()).padStart(2, '0')}`;
}

export function monthRange(offset = 0, now = new Date()) {
  return {
    from: dateKey(new Date(now.getFullYear(), now.getMonth() + offset, 1)),
    to: dateKey(new Date(now.getFullYear(), now.getMonth() + offset + 1, 0))
  };
}

export function dateBounds(from: string, to: string) {
  const start = from ? new Date(`${from}T00:00:00`) : undefined;
  const end = to ? new Date(`${to}T00:00:00`) : undefined;
  // The API expands its `to` timestamp to the end of that day.
  return { from: start?.getTime(), to: end?.getTime() };
}

// Accumulate cents and keep non-cash entries out of the cash-flow total.
export function summarizeLedger(entries: LedgerEntry[]) {
  const cents = { income: 0, expense: 0, receivable: 0, payable: 0, settlement: 0 };
  for (const entry of entries) {
    if (!entry.voided_at) cents[entry.type] += Math.round(entry.amount * 100);
  }
  return {
    income: cents.income / 100,
    expense: cents.expense / 100,
    receivable: cents.receivable / 100,
    payable: cents.payable / 100,
    settlement: cents.settlement / 100,
    net: (cents.income - cents.expense) / 100
  };
}

export function filterLedger(entries: LedgerEntry[], type: LedgerType | '', keyword: string) {
  const search = keyword.trim().toLowerCase();
  return entries.filter(entry => !entry.voided_at && (!type || entry.type === type) && (!search ||
    String(entry.party_name || '').toLowerCase().includes(search) || String(entry.remark || '').toLowerCase().includes(search)));
}

export function groupLedger(entries: LedgerEntry[]) {
  const groups = new Map<string, { date: string; entries: LedgerEntry[] }>();
  const sorted = [...entries].sort((a, b) => b.created_at - a.created_at || b.id - a.id);
  for (const entry of sorted) {
    const date = dateKey(new Date(entry.created_at));
    if (!groups.has(date)) groups.set(date, { date, entries: [] });
    groups.get(date)!.entries.push(entry);
  }
  return [...groups.values()];
}

export function amountPrefix(type: LedgerType) {
  return type === 'income' ? '+' : type === 'expense' ? '-' : '';
}

export function isLinkedEntry(entry: LedgerEntry) {
  // 交易/送货单关联的账务必须走原单作废；单纯往来结算/补录可由账本作废（后端会同步恢复往来余额）。
  return Boolean(entry.transaction_id || entry.delivery_note_id);
}
