import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';

const read = (p: string) => readFileSync(p, 'utf8');

describe('merit-integrity boundary (US-RG, structural)', () => {
  it('scoring/discovery source never references resource gifts', () => {
    // engagement/service.ts + social.ts feed recomputeProjectScore; scoring/service.ts
    // does the maths; discovery/service.ts ranks. None of them may know gifts exist.
    for (const f of [
      'src/modules/engagement/service.ts',
      'src/modules/engagement/social.ts',
      'src/modules/scoring/service.ts',
      'src/modules/discovery/service.ts',
    ]) {
      const src = read(f);
      expect(src).not.toMatch(/resourceGifts|resource_gifts/);
    }
  });

  it('scoring/discovery source never imports from @/modules/commitments', () => {
    // A future indirect leak via a Commitments helper (e.g. re-exporting a gift
    // lookup) would evade the table-name check above. Close that off directly.
    for (const f of [
      'src/modules/engagement/service.ts',
      'src/modules/engagement/social.ts',
      'src/modules/scoring/service.ts',
      'src/modules/discovery/service.ts',
    ]) {
      const src = read(f);
      expect(src).not.toMatch(/from ['"]@\/modules\/commitments['"]/);
    }
  });

  it('the scoring engagement-source allowlist is closed to on_platform/facebook/twitter', () => {
    // The literal source strings live across service.ts (on_platform) and social.ts
    // (facebook/twitter). Any newly-introduced source string must be a deliberate,
    // reviewed change — not a silent gift/donation channel slipping into scoring.
    const src =
      read('src/modules/engagement/service.ts') + read('src/modules/engagement/social.ts');
    const sources = [
      ...src.matchAll(/'(on_platform|facebook|twitter|instagram|tiktok|linkedin|youtube)'/g),
    ].map((m) => m[1]);
    const unexpected = sources.filter((s) => !['on_platform', 'facebook', 'twitter'].includes(s!));
    expect(unexpected).toEqual([]);
  });

  it('scoring/discovery source never references plans, subscriptions or entitlements (US-10.4)', () => {
    // Payment tier must have zero effect on support scores or discovery rank.
    // The gift- and agent-blind guards below existed; this one did not, so
    // "plan tier is never an input" was asserted by nothing until US-10.1 was
    // actually built.
    const forbidden = new RegExp(
      [
        '\\bplans\\b',
        '\\bsubscriptions\\b',
        '\\bentitlements\\b',
        'hasEntitlement',
        'planCode',
      ].join('|'),
    );
    for (const f of [
      'src/modules/engagement/service.ts',
      'src/modules/engagement/social.ts',
      'src/modules/scoring/service.ts',
      'src/modules/discovery/service.ts',
    ]) {
      expect(read(f)).not.toMatch(forbidden);
    }
  });

  it('scoring/discovery source never references messaging (US-8.3)', () => {
    // Conversation volume must never become a ranking signal: a charity that
    // talks more is not a charity that deserves more support. Merit is public
    // support and delivered work, nothing else.
    const forbidden = new RegExp(
      // '\\b' — a single backslash here is a JS escape for U+0008 (backspace),
      // which matches nothing. Same bite as the US-10.4 guard twenty lines up.
      ['message_threads', 'messageThreads', '\\bmessages\\b', '@/modules/messaging'].join('|'),
    );
    for (const f of [
      'src/modules/engagement/service.ts',
      'src/modules/engagement/social.ts',
      'src/modules/scoring/service.ts',
      'src/modules/discovery/service.ts',
    ]) {
      expect(read(f)).not.toMatch(forbidden);
    }
  });

  it('scoring/discovery source never references agent-delivery run tables', () => {
    const forbidden =
      /agent_delivery_runs|agentDeliveryRuns|run_budgets|runBudgets|run_budget_ledger|run_milestones|runMilestones|agent_steps|agentSteps|compute_pledges|computePledges|deployed_environments|deployedEnvironments/;
    for (const f of [
      'src/modules/engagement/service.ts',
      'src/modules/engagement/social.ts',
      'src/modules/scoring/service.ts',
      'src/modules/discovery/service.ts',
    ]) {
      expect(read(f)).not.toMatch(forbidden);
    }
  });

  it('scoring/discovery source never imports from @/modules/agent-delivery', () => {
    for (const f of [
      'src/modules/engagement/service.ts',
      'src/modules/engagement/social.ts',
      'src/modules/scoring/service.ts',
      'src/modules/discovery/service.ts',
    ]) {
      expect(read(f)).not.toMatch(/from ['"]@\/modules\/agent-delivery['"]/);
    }
  });
});
