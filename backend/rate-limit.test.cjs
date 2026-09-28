const { test } = require('node:test');
const assert = require('node:assert/strict');
const { consumeRateLimit } = require('./rate-limit');

test('rate limiter prunes expired keys at capacity without dropping active keys', () => {
  const buckets = new Map([
    ['active', { count: 1, resetAt: 120 }],
    ['expired', { count: 1, resetAt: 99 }]
  ]);
  assert.equal(consumeRateLimit(buckets, 'new', { limit: 2, windowMs: 100, now: 100, maxBuckets: 2 }), true);
  assert.equal(buckets.has('expired'), false);
  assert.equal(buckets.has('active'), true);
  assert.equal(buckets.has('new'), true);
});

test('rate limiter stays within its key cap and refuses new keys instead of evicting active buckets', () => {
  const buckets = new Map();
  assert.equal(consumeRateLimit(buckets, 'one', { limit: 2, now: 100, maxBuckets: 2 }), true);
  assert.equal(consumeRateLimit(buckets, 'two', { limit: 2, now: 100, maxBuckets: 2 }), true);
  assert.equal(consumeRateLimit(buckets, 'three', { limit: 2, now: 100, maxBuckets: 2 }), false);
  assert.equal(consumeRateLimit(buckets, 'one', { limit: 2, now: 100, maxBuckets: 2 }), true);
  assert.equal(consumeRateLimit(buckets, 'one', { limit: 2, now: 100, maxBuckets: 2 }), false);
  assert.deepEqual([...buckets.keys()], ['one', 'two']);
});
