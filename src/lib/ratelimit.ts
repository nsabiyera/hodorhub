/**
 * In-process fixed-window rate limiter (TECH_DEBT H1). Per-instance only — good
 * enough to blunt brute-force / abuse on a single Cloud Run instance; a
 * Redis-backed limiter is the horizontal-scale version (tracked).
 */
export interface RateLimitResult {
  allowed: boolean;
  retryAfterMs: number;
}

export function createRateLimiter(limit: number, windowMs: number) {
  const buckets = new Map<string, { count: number; resetAt: number }>();

  return function check(key: string, now: number = Date.now()): RateLimitResult {
    const bucket = buckets.get(key);
    if (!bucket || now >= bucket.resetAt) {
      buckets.set(key, { count: 1, resetAt: now + windowMs });
      return { allowed: true, retryAfterMs: 0 };
    }
    if (bucket.count >= limit) {
      return { allowed: false, retryAfterMs: bucket.resetAt - now };
    }
    bucket.count += 1;
    return { allowed: true, retryAfterMs: 0 };
  };
}
