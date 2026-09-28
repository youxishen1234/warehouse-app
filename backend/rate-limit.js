const DEFAULT_MAX_RATE_BUCKETS = 10000;

function maxRateBuckets() {
  const configured = Number(process.env.WAREHOUSE_RATE_LIMIT_MAX_BUCKETS);
  return Number.isSafeInteger(configured) && configured > 0
    ? Math.min(configured, 100000)
    : DEFAULT_MAX_RATE_BUCKETS;
}

/**
 * Consume one fixed-window rate-limit token while keeping attacker-controlled
 * source keys from growing the bucket map without bound. Expired entries are
 * pruned when capacity is reached; active entries are never evicted to admit
 * a new source, so rotating identifiers cannot erase another source's limit.
 */
function consumeRateLimit(buckets, key, { limit, windowMs = 60000, now = Date.now(), maxBuckets = maxRateBuckets() } = {}) {
  if (!(buckets instanceof Map)) throw new TypeError('rate limit buckets must be a Map');
  if (!Number.isSafeInteger(limit) || limit < 1 || !Number.isSafeInteger(windowMs) || windowMs < 1) {
    throw new TypeError('rate limit and window must be positive safe integers');
  }
  const bucketKey = String(key);
  const current = buckets.get(bucketKey);
  if (current && current.resetAt > now) {
    if (current.count >= limit) return false;
    current.count += 1;
    return true;
  }
  if (current) buckets.delete(bucketKey);

  if (buckets.size >= maxBuckets) {
    for (const [expiredKey, bucket] of buckets) {
      if (!bucket || bucket.resetAt <= now) buckets.delete(expiredKey);
    }
  }
  if (buckets.size >= maxBuckets) return false;
  buckets.set(bucketKey, { count: 1, resetAt: now + windowMs });
  return true;
}

module.exports = { consumeRateLimit, maxRateBuckets, DEFAULT_MAX_RATE_BUCKETS };
