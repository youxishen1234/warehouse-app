import type { Product } from '@/types';
export type GoodDraft = { goods?: string; specification?: string; material?: string; unit?: string; price?: number | null };
export function completeGood(item: GoodDraft | null | undefined): boolean;
export function matchingProducts(item: GoodDraft, products: Product[], cartonOnly?: boolean): Product[];
export function lineAmount(line: {unit_price: string; delivered_qty: string}): number | null;
export function draftTotal(lines: Array<{unit_price: string; delivered_qty: string}>): number | null;
