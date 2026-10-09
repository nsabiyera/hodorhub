import { describe, it, expect } from 'vitest';
import { createRateLimiter } from './ratelimit';

describe('createRateLimiter', () => {
  it('allows up to the limit within a window, then blocks', () => {
    const check = createRateLimiter(2, 1000);
    expect(check('ip', 0).allowed).toBe(true);
    expect(check('ip', 100).allowed).toBe(true);
    const third = check('ip', 200);
    expect(third.allowed).toBe(false);
    expect(third.retryAfterMs).toBe(800); // resetAt (1000) − now (200)
  });

  it('resets after the window elapses', () => {
    const check = createRateLimiter(1, 1000);
    expect(check('ip', 0).allowed).toBe(true);
    expect(check('ip', 500).allowed).toBe(false);
    expect(check('ip', 1000).allowed).toBe(true); // new window
  });

  it('tracks keys independently', () => {
    const check = createRateLimiter(1, 1000);
    expect(check('a', 0).allowed).toBe(true);
    expect(check('b', 0).allowed).toBe(true);
    expect(check('a', 0).allowed).toBe(false);
  });
});
