import { describe, it, expect } from 'vitest';
import { computeSupportScore, decayFactor, capSources, computeScores } from './service';

describe('computeSupportScore (SUPPORT_SCORE_MODEL §5)', () => {
  it('is 0 for no support and grows ~100 points per 10× (log compression)', () => {
    expect(computeSupportScore(0)).toBe(0);
    expect(computeSupportScore(1)).toBe(30); // round(100·log10(2))
    expect(computeSupportScore(9)).toBe(100); // round(100·log10(10))
    expect(computeSupportScore(99)).toBe(200); // round(100·log10(100))
    expect(computeSupportScore(999)).toBe(300);
  });

  it('is monotonic non-decreasing in support count', () => {
    let prev = -1;
    for (const r of [0, 1, 2, 5, 10, 50, 100, 1000]) {
      const s = computeSupportScore(r);
      expect(s).toBeGreaterThanOrEqual(prev);
      prev = s;
    }
  });

  it('never goes negative for degenerate input', () => {
    expect(computeSupportScore(-5)).toBe(0);
  });
});

describe('decayFactor (7-day half-life, §3.2)', () => {
  it('is 1 at age 0 and ~0.5 at 7 days', () => {
    expect(decayFactor(0)).toBe(1);
    expect(decayFactor(7)).toBeCloseTo(0.5, 5);
    expect(decayFactor(14)).toBeCloseTo(0.25, 5);
  });
  it('is monotonically decreasing and clamps negative ages to 1', () => {
    expect(decayFactor(1)).toBeGreaterThan(decayFactor(2));
    expect(decayFactor(-3)).toBe(1);
  });
});

describe('capSources (§4 per-source cap)', () => {
  it('does not cap a lone source', () => {
    expect(capSources([4])).toBe(4);
    expect(capSources([4, 0, 0])).toBe(4);
    expect(capSources([])).toBe(0);
  });
  it('caps the top source to the sum of the others (top ≤ 50% of R)', () => {
    // top 8 vs others 2 → capped to 2 → R = 4, top is exactly 50%.
    expect(capSources([8, 2])).toBe(4);
    // top 4 vs others 3 → 4 ≤ 3? no → capped to 3 → R = 6.
    expect(capSources([4, 2, 1])).toBe(6);
  });
  it('leaves a balanced multi-source total unchanged', () => {
    expect(capSources([3, 3])).toBe(6); // top(3) ≤ others(3) → uncapped
  });
});

describe('computeScores', () => {
  it('momentum equals support for fresh contributions', () => {
    const fresh = [{ source: 'on_platform', value: 1, ageDays: 0 }];
    const s = computeScores(fresh);
    expect(s.momentumScore).toBe(s.supportScore);
    expect(s.rawR).toBe(1);
  });
  it('momentum is lower than support once contributions age', () => {
    const aged = [{ source: 'facebook', value: 100, ageDays: 14 }];
    const s = computeScores(aged);
    expect(s.momentumScore).toBeLessThan(s.supportScore);
    expect(s.rawR).toBe(100); // cumulative uncapped (single source)
  });
  it('applies the per-source cap to rawR across sources', () => {
    const s = computeScores([
      { source: 'facebook', value: 8, ageDays: 0 },
      { source: 'on_platform', value: 2, ageDays: 0 },
    ]);
    expect(s.rawR).toBe(4); // facebook capped 8→2, +2 = 4
  });
});
