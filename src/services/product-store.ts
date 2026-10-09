import { getProducts } from '@/services/api';
import type { Product } from '@/types';

let cached: Product[] | null = null;
let cachedAt = 0;
let pending: Promise<Product[]> | null = null;
let requestSeq = 0;
const TTL = 30_000;

/** Shares the read-only product list between pages during a navigation burst. */
export function loadProducts(force = false): Promise<Product[]> {
  const now = Date.now();
  if (!force && cached && now - cachedAt < TTL) return Promise.resolve(cached);
  if (!force && pending) return pending;
  // force 会发起新请求；序号保证迟到的旧响应不会覆盖更新鲜的缓存。
  const seq = ++requestSeq;
  const request = getProducts()
    .then(products => {
      if (seq === requestSeq) { cached = products; cachedAt = Date.now(); }
      return products;
    });
  const tracked = request.finally(() => { if (pending === tracked) pending = null; });
  pending = tracked;
  return tracked;
}

export function invalidateProducts() {
  cached = null;
  cachedAt = 0;
}

