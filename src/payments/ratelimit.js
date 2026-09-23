// src/payments/ratelimit.js — in-memory sliding-window rate limiter.
// Dependency-free. Guards free/mock and test surfaces from abuse (audit item #1).
// For production, swap the backend for a shared store (KV/Redis) — see connectStore.

const buckets = new Map(); // key -> { windowStart, count }

// windowMs: length of the window; max: max requests per window.
// Returns { ok: true } or { ok: false, retryAfterMs }.
export function rateLimit(key, { max = 100, windowMs = 60_000, now = Date.now } = {}) {
  const t = now();
  let b = buckets.get(key);
  if (!b) {
    b = { windowStart: t, count: 0 };
    buckets.set(key, b);
  }
  if (t - b.windowStart >= windowMs) {
    b.windowStart = t;
    b.count = 0;
  }
  if (b.count >= max) {
    return { ok: false, retryAfterMs: Math.max(0, windowMs - (t - b.windowStart)) };
  }
  b.count++;
  return { ok: true };
}

// Opportunistic cleanup to avoid unbounded growth (call periodically).
export function clearExpired({ now = Date.now, windowMs = 60_000 } = {}) {
  const t = now();
  const cutoff = t - windowMs;
  for (const [k, b] of buckets) {
    if (b.windowStart < cutoff) buckets.delete(k);
  }
}

export function _bucketCount() { return buckets.size; } // for tests