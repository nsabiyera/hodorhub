import type { ModelTier, ModelUsage } from '@/lib/model-provider';

export const PRICE_BOOK_VERSION = '2026-07-anthropic';

/**
 * Pinned USD→GBP conversion for the pence-denominated ledger. A documented
 * assumption, NOT a live FX feed — the ceiling guarantee (actual ≤ reserved)
 * is independent of this number because reservation and settlement use the
 * same priceBook. Update deliberately and bump PRICE_BOOK_VERSION when you do.
 */
export const USD_TO_GBP = 0.8;

export interface ModelRate {
  inputPerMTokens: number;
  outputPerMTokens: number;
}

/**
 * Price book: pence per 1,000,000 tokens, per tier.
 * Derived as USD_per_MTok × USD_TO_GBP × 100, at STANDARD (non-intro) Claude
 * rates so reservations stay safe after any promotional pricing ends:
 *   planner/reviewer → Claude Opus 4.8   ($5 in / $25 out)
 *   worker           → Claude Sonnet 5   ($3 in / $15 out, standard)
 */
export const priceBook: Record<ModelTier, ModelRate> = {
  planner: { inputPerMTokens: 400, outputPerMTokens: 2000 },
  worker: { inputPerMTokens: 240, outputPerMTokens: 1200 },
  reviewer: { inputPerMTokens: 400, outputPerMTokens: 2000 },
};

export function estimateMaxCostMinor(
  tier: ModelTier,
  promptTokens: number,
  maxOutputTokens: number,
  rates: Record<ModelTier, ModelRate> = priceBook,
): number {
  const r = rates[tier];
  return Math.ceil(
    (promptTokens * r.inputPerMTokens + maxOutputTokens * r.outputPerMTokens) / 1_000_000,
  );
}

export function actualCostMinor(
  tier: ModelTier,
  usage: ModelUsage,
  rates: Record<ModelTier, ModelRate> = priceBook,
): number {
  const r = rates[tier];
  const inputLike = usage.inputTokens + usage.cacheTokens;
  return Math.ceil(
    (inputLike * r.inputPerMTokens + usage.outputTokens * r.outputPerMTokens) / 1_000_000,
  );
}
