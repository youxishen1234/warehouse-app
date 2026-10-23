import type { DeliveryNote, LedgerEntry } from '@/types';

export type ProductionInboundSummary = { total: number; count: number; notes: DeliveryNote[] };
export type PartyLedgerSummary = { sales: number; settled: number };
export type PartyPeriod = '本月' | '上月' | '全部时间';

export function partyPeriodLabel(period: PartyPeriod): string {
  return period === '全部时间' ? '累计' : period;
}

export function inferredPartyType(entry: LedgerEntry): 'customer' | 'supplier' | null {
  if (entry.party_type) return entry.party_type;
  if (entry.type === 'receivable') return 'customer';
  if (entry.type === 'payable') return 'supplier';
  return null;
}

export function filterPartyLedgerEntries(
  entries: LedgerEntry[],
  partyType: 'customer' | 'supplier',
  partyId: number,
  from = '',
  to = ''
): LedgerEntry[] {
  const start = from ? new Date(`${from}T00:00:00`).getTime() : Number.NEGATIVE_INFINITY;
  const end = to ? new Date(`${to}T23:59:59.999`).getTime() : Number.POSITIVE_INFINITY;
  if ((from && !Number.isFinite(start)) || (to && !Number.isFinite(end))) return [];
  return entries.filter(entry =>
    !entry.voided_at &&
    entry.party_id != null &&
    Number(entry.party_id) === Number(partyId) &&
    inferredPartyType(entry) === partyType &&
    entry.created_at >= start &&
    entry.created_at <= end
  );
}

export function summarizePartyLedger(entries: LedgerEntry[], partyType: 'customer' | 'supplier'): PartyLedgerSummary {
  let sales = 0;
  let settled = 0;
  for (const entry of entries) {
    const amountCents = cents(entry.amount);
    if (entry.type === (partyType === 'supplier' ? 'payable' : 'receivable')) sales += amountCents;
    else if (entry.type === 'settlement') settled += amountCents;
  }
  return { sales: sales / 100, settled: settled / 100 };
}

const cents = (value: unknown) => {
  const amount = Number(value);
  return Number.isFinite(amount) ? Math.round((amount + Number.EPSILON) * 100) : 0;
};

export function productionNoteAmount(note: DeliveryNote): number {
  const total = Number(note.total_amount);
  if (Number.isFinite(total)) return cents(total) / 100;
  return (note.lines || []).reduce((sum, line) => sum + cents(line.amount), 0) / 100;
}

/**
 * Customer-produced-carton receipts are a distinct display source from
 * outbound receivables. Use the delivery note's business date (not created_at),
 * and keep voided notes out of both the count and amount.
 */
export function summarizeProductionInbound(
  notes: DeliveryNote[],
  customerId: number,
  from = '',
  to = ''
): ProductionInboundSummary {
  const matched = notes
    .filter(note =>
      note.source_type === 'production' &&
      note.customer_id != null &&
      Number(note.customer_id) === Number(customerId) &&
      !note.voided_at &&
      (!from || note.date >= from) &&
      (!to || note.date <= to)
    )
    .sort((a, b) => b.date.localeCompare(a.date) || b.id - a.id);
  return {
    total: matched.reduce((sum, note) => sum + cents(productionNoteAmount(note)), 0) / 100,
    count: matched.length,
    notes: matched
  };
}
