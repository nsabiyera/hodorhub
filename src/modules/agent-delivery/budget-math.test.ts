import { describe, it, expect } from 'vitest';
import {
  estimateMaxCostMinor,
  actualCostMinor,
  priceBook,
  PRICE_BOOK_VERSION,
  USD_TO_GBP,
} from './budget-math';

describe('budget-math', () => {
  it('estimates the worst-case (max output) cost in minor units', () => {
    // planner: 400 in / 2000 out per 1e6 tokens → 1000 in + 1000 out
    // = (1000*400 + 1000*2000)/1e6 = 2.4 → ceil 3
    expect(estimateMaxCostMinor('planner', 1000, 1000)).toBe(3);
  });

  it('never lets actual exceed the estimate when output stays within the cap', () => {
    const tier = 'worker' as const;
    const promptTokens = 5000;
    const maxOutputTokens = 4000;
    const estimate = estimateMaxCostMinor(tier, promptTokens, maxOutputTokens);
    const actual = actualCostMinor(tier, {
      inputTokens: promptTokens,
      outputTokens: 4000, // used the full cap
      cacheTokens: 0,
    });
    expect(actual).toBeLessThanOrEqual(estimate);
  });

  it('counts cache tokens at the input rate', () => {
    const withCache = actualCostMinor('reviewer', {
      inputTokens: 0,
      outputTokens: 0,
      cacheTokens: 1_000_000,
    });
    expect(withCache).toBe(priceBook.reviewer.inputPerMTokens);
  });
});

describe('price book calibration (Slice 3b)', () => {
  it('pins the calibrated version and FX', () => {
    expect(PRICE_BOOK_VERSION).toBe('2026-07-anthropic');
    expect(USD_TO_GBP).toBe(0.8);
  });

  it('prices Opus tiers (planner/reviewer) at $5/$25 → 400/2000 pence per MTok', () => {
    expect(priceBook.planner).toEqual({ inputPerMTokens: 400, outputPerMTokens: 2000 });
    expect(priceBook.reviewer).toEqual({ inputPerMTokens: 400, outputPerMTokens: 2000 });
  });

  it('prices the worker tier at Sonnet 5 STANDARD $3/$15 → 240/1200 (not intro 160/800)', () => {
    expect(priceBook.worker).toEqual({ inputPerMTokens: 240, outputPerMTokens: 1200 });
  });

  it('keeps the ceiling invariant: actual ≤ reserved when usage stays within the reserved max', () => {
    const tier = 'worker' as const;
    const promptTokens = 4000;
    const maxOutputTokens = 8000;
    const reserved = estimateMaxCostMinor(tier, promptTokens, maxOutputTokens);
    // real usage at or below the reserved bounds
    const actual = actualCostMinor(tier, { inputTokens: 4000, outputTokens: 8000, cacheTokens: 0 });
    expect(actual).toBeLessThanOrEqual(reserved);
  });
});

describe('reservation covers realistic input (Plan B1)', () => {
  it('reserving against (scaffolding + prior maxOutput) is >= actual when real input approaches the prior artifact cap', () => {
    // design phase: scaffolding guess 1800, prior (requirements) maxOutput 2000
    const tier = 'planner' as const;
    const reservedPromptTokens = 1800 + 2000; // conservative upper bound
    const reserved = estimateMaxCostMinor(tier, reservedPromptTokens, 3000);
    // real input near the cap: 1800 scaffolding + a ~2000-token prior artifact
    const actual = actualCostMinor(tier, { inputTokens: 3800, outputTokens: 3000, cacheTokens: 0 });
    expect(actual).toBeLessThanOrEqual(reserved);
  });
});
