import { describe, it, expect } from 'vitest';
import { AnthropicModelProvider, TIER_MODELS } from './anthropic-model-provider';
import type { ModelRequest } from './model-provider';

/** Records the args it was called with and returns a scripted response. */
function fakeClient<T>(response: T) {
  const calls: unknown[] = [];
  return {
    calls,
    client: {
      messages: {
        create: async (args: unknown) => {
          calls.push(args);
          return response;
        },
      },
    },
  };
}

const baseReq: ModelRequest = {
  tier: 'planner',
  system: 'sys',
  prompt: 'do the thing',
  maxOutputTokens: 2000,
};

describe('AnthropicModelProvider', () => {
  it('maps tiers to the correct Claude model ids', () => {
    expect(TIER_MODELS).toEqual({
      planner: 'claude-opus-4-8',
      worker: 'claude-sonnet-5',
      reviewer: 'claude-opus-4-8',
    });
  });

  it('sends model, max_tokens, system, a single user message, and disabled thinking; no sampling params', async () => {
    const f = fakeClient({
      content: [{ type: 'text', text: 'hello' }],
      model: 'claude-opus-4-8',
      usage: { input_tokens: 10, output_tokens: 5 },
      stop_reason: 'end_turn',
    });
    const provider = new AnthropicModelProvider(f.client);
    await provider.complete({ ...baseReq, tier: 'worker', maxOutputTokens: 8000 });
    const args = f.calls[0] as Record<string, unknown>;
    expect(args.model).toBe('claude-sonnet-5');
    expect(args.max_tokens).toBe(8000);
    expect(args.system).toBe('sys');
    expect(args.messages).toEqual([{ role: 'user', content: 'do the thing' }]);
    expect(args.thinking).toEqual({ type: 'disabled' });
    expect(args).not.toHaveProperty('temperature');
    expect(args).not.toHaveProperty('top_p');
    expect(args).not.toHaveProperty('top_k');
  });

  it('concatenates text blocks, maps usage (cache→cacheTokens), and reports modelId', async () => {
    const f = fakeClient({
      content: [
        { type: 'text', text: 'part one ' },
        { type: 'thinking', thinking: 'ignored' },
        { type: 'text', text: 'part two' },
      ],
      model: 'claude-opus-4-8',
      usage: { input_tokens: 100, output_tokens: 200, cache_read_input_tokens: 40 },
      stop_reason: 'end_turn',
    });
    const provider = new AnthropicModelProvider(f.client);
    const res = await provider.complete(baseReq);
    expect(res.text).toBe('part one part two');
    expect(res.modelId).toBe('claude-opus-4-8');
    expect(res.usage).toEqual({ inputTokens: 100, outputTokens: 200, cacheTokens: 40 });
    expect(res.stopReason).toBe('end');
  });

  it('maps stop reasons: max_tokens/refusal/stop_sequence pass through, unknown → end', async () => {
    const mk = (stop: string) =>
      new AnthropicModelProvider(
        fakeClient({
          content: [{ type: 'text', text: 'x' }],
          model: 'm',
          usage: { input_tokens: 1, output_tokens: 1 },
          stop_reason: stop,
        }).client,
      ).complete(baseReq);
    expect((await mk('max_tokens')).stopReason).toBe('max_tokens');
    expect((await mk('refusal')).stopReason).toBe('refusal');
    expect((await mk('stop_sequence')).stopReason).toBe('stop_sequence');
    expect((await mk('tool_use')).stopReason).toBe('end');
    expect((await mk('end_turn')).stopReason).toBe('end');
  });

  it('propagates a thrown API error (orchestrator releases + halts)', async () => {
    const provider = new AnthropicModelProvider({
      messages: {
        create: async () => {
          throw new Error('429 rate limited');
        },
      },
    });
    await expect(provider.complete(baseReq)).rejects.toThrow('429 rate limited');
  });
});
