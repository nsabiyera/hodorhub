import { describe, it, expect } from 'vitest';
import { FakeModelProvider } from './fake-model-provider';

describe('FakeModelProvider', () => {
  it('returns scripted responses in order and records calls', async () => {
    const p = new FakeModelProvider([
      { text: 'first', usage: { outputTokens: 500 } },
      { text: 'second' },
    ]);
    const a = await p.complete({ tier: 'planner', prompt: 'x', maxOutputTokens: 1000 });
    const b = await p.complete({ tier: 'worker', prompt: 'y', maxOutputTokens: 1000 });
    expect(a.text).toBe('first');
    expect(a.usage.outputTokens).toBe(500);
    expect(b.text).toBe('second');
    expect(b.usage.outputTokens).toBe(200); // default
    expect(p.calls).toHaveLength(2);
    expect(p.calls[0]!.tier).toBe('planner');
  });

  it('falls back to a default response when the script is exhausted', async () => {
    const p = new FakeModelProvider();
    const r = await p.complete({ tier: 'reviewer', prompt: 'z', maxOutputTokens: 10 });
    expect(r.text).toBe('ok');
    expect(r.stopReason).toBe('end');
    expect(r.modelId).toBe('fake-reviewer');
  });
});
