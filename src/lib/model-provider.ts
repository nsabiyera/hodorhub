/**
 * Swappable model provider (mirrors lib/mailer, ADR 0001). Orchestration code
 * depends only on this interface — never a vendor SDK — so the provider is
 * swappable and the whole pipeline is testable with a fake. Every call reports
 * token usage so the budget ledger (agent-delivery) can meter spend.
 */
export type ModelTier = 'planner' | 'worker' | 'reviewer';

export interface ModelUsage {
  inputTokens: number;
  outputTokens: number;
  cacheTokens: number;
}

export interface ModelRequest {
  tier: ModelTier;
  system?: string;
  prompt: string;
  /** Hard cap on output tokens — priced at reservation so actual ≤ reserved. */
  maxOutputTokens: number;
}

export interface ModelResponse {
  text: string;
  modelId: string;
  usage: ModelUsage;
  stopReason: 'end' | 'max_tokens' | 'stop_sequence' | 'refusal';
}

export interface ModelProvider {
  complete(req: ModelRequest): Promise<ModelResponse>;
}
