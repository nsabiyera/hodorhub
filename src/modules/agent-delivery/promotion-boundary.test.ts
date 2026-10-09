import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';

const read = (p: string) => readFileSync(p, 'utf8');

/**
 * US-11.8, structural half: "the agents never promote to production
 * themselves". The behavioural half lives in
 * promotion-boundary.integration.test.ts, which drives a whole run and asserts
 * every deploy was to staging. These guards are the cheaper, faster tripwire:
 * they fail the moment someone gives the agent path a route to the promotion
 * code, before any test needs to notice the wrong environment going out.
 */
describe('production promotion boundary (US-11.8, structural)', () => {
  const AGENT_PATH = [
    'src/modules/agent-delivery/dispatcher.ts',
    'src/modules/agent-delivery/orchestrator.ts',
    'src/modules/agent-delivery/delivery.ts',
  ];

  it('nothing on the agent path imports the promotion module', () => {
    for (const f of AGENT_PATH) {
      expect(read(f)).not.toMatch(/from '\.\/promotion'|promotion'/);
    }
  });

  it('nothing on the agent path names the production environment', () => {
    // The delivery phase deploys to 'staging' and nothing else. A 'production'
    // literal appearing here would mean an agent-driven phase can choose the
    // environment — exactly what this story forbids.
    for (const f of AGENT_PATH) {
      expect(read(f)).not.toMatch(/'production'/);
    }
  });

  it('the delivery phase pins its deploy to staging', () => {
    const src = read('src/modules/agent-delivery/delivery.ts');
    const environments = [...src.matchAll(/environment: '(\w+)'/g)].map((m) => m[1]);
    expect(environments).toContain('staging');
    expect(new Set(environments)).toEqual(new Set(['staging']));
  });

  it('only the promotion module deploys to production', () => {
    const src = read('src/modules/agent-delivery/promotion.ts');
    expect(src).toMatch(/environment: 'production'/);
  });
});
