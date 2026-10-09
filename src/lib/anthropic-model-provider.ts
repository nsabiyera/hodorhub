import Anthropic from '@anthropic-ai/sdk';
import type { ModelProvider, ModelRequest, ModelResponse, ModelTier } from './model-provider';

/**
 * Real Claude ModelProvider (Epic 11, Slice 3b). Orchestration depends only on
 * the ModelProvider interface; this maps each tier to a Claude model, reports
 * real token usage to the budget ledger, and disables thinking for bounded,
 * predictable output. Sandbox and deployer remain fake (Plan B).
 */
export const TIER_MODELS: Record<ModelTier, string> = {
  planner: 'claude-opus-4-8',
  worker: 'claude-sonnet-5',
  reviewer: 'claude-opus-4-8',
};

/** Minimal structural shape of the Anthropic client so tests can inject a fake. */
export interface AnthropicClientLike {
  messages: {
    create(args: {
      model: string;
      max_tokens: number;
      system?: string;
      thinking: { type: 'disabled' };
      messages: Array<{ role: 'user'; content: string }>;
    }): Promise<{
      content: Array<{ type: string; text?: string }>;
      model: string;
      usage: { input_tokens: number; output_tokens: number; cache_read_input_tokens?: number };
      stop_reason: string | null;
    }>;
  };
}

function mapStopReason(reason: string | null): ModelResponse['stopReason'] {
  switch (reason) {
    case 'max_tokens':
      return 'max_tokens';
    case 'stop_sequence':
      return 'stop_sequence';
    case 'refusal':
      return 'refusal';
    default:
      // end_turn, tool_use, pause_turn (not expected — no tools), null → 'end'
      return 'end';
  }
}

export class AnthropicModelProvider implements ModelProvider {
  private client: AnthropicClientLike | undefined;

  // Optional injected client (tests pass a fake). When omitted, the real SDK
  // client is constructed LAZILY on first complete() — never at construction —
  // because `new Anthropic()` throws if ANTHROPIC_API_KEY is unset, and the
  // factory constructs this provider in environments (tests, build) with no key.
  constructor(client?: AnthropicClientLike) {
    this.client = client;
  }

  async complete(req: ModelRequest): Promise<ModelResponse> {
    // Lazy init: resolves ANTHROPIC_API_KEY from the environment (no key arg).
    this.client ??= new Anthropic() as unknown as AnthropicClientLike;
    const response = await this.client.messages.create({
      model: TIER_MODELS[req.tier],
      max_tokens: req.maxOutputTokens,
      system: req.system,
      thinking: { type: 'disabled' },
      messages: [{ role: 'user', content: req.prompt }],
    });

    const text = response.content
      .filter((b) => b.type === 'text' && typeof b.text === 'string')
      .map((b) => b.text as string)
      .join('');

    return {
      text,
      modelId: response.model,
      usage: {
        inputTokens: response.usage.input_tokens,
        outputTokens: response.usage.output_tokens,
        cacheTokens: response.usage.cache_read_input_tokens ?? 0,
      },
      stopReason: mapStopReason(response.stop_reason),
    };
  }
}
