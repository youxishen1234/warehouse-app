import { getProducts } from '@/services/api';
import type { Product } from '@/types';

let cached: Product[] | null = null;
let cachedAt = 0;
let pending: Promise<Product[]> | null = null;
const TTL = 30_000;

/** Shares the read-only product list between pages during a navigation burst. */
export function loadProducts(force = false): Promise<Product[]> {
  const now = Date.now();
  if (!force && cached && now - cachedAt < TTL) return Promise.resolve(cached);
  if (!force && pending) return pending;
  pending = getProducts()
    .then(products => {
      cached = products;
      cachedAt = Date.now();
      return products;
    })
    .finally(() => { pending = null; });
  return pending;
}

export function invalidateProducts() {
  cached = null;
  cachedAt = 0;
}

