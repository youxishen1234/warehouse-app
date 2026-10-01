import { getProducts } from '@/services/api';
import type { Product } from '@/types';

let cached: Product[] | null = null;
let cachedAt = 0;
let pending: Promise<Product[]> | null = null;
let generation = 0;
const TTL = 30_000;

/** Shares the read-only product list between pages during a navigation burst. */
export function loadProducts(force = false): Promise<Product[]> {
  const now = Date.now();
  if (!force && cached && now - cachedAt < TTL) return Promise.resolve(cached);
  // A forced refresh bypasses the cache, not a request already fetching the
  // same generation. Returning to a page used to start several identical reads.
  if (pending) return pending;
  const startedGeneration = generation;
  const request = getProducts()
    .then(products => {
      if (startedGeneration === generation) {
        cached = products;
        cachedAt = Date.now();
      }
      return products;
    })
    .finally(() => { if (pending === request) pending = null; });
  pending = request;
  return pending;
}

export function invalidateProducts() {
  generation += 1;
  pending = null;
  cached = null;
  cachedAt = 0;
}

