import { describe, it, expect } from 'vitest';
import { isTransitionAllowed, type ProjectStatus } from './service';

const ALL: ProjectStatus[] = ['draft', 'published', 'in_delivery', 'completed', 'archived'];
const LEGAL = new Set([
  'draft>published',
  'draft>archived',
  'published>in_delivery',
  'published>archived',
  'in_delivery>published',
  'in_delivery>completed',
  'completed>archived',
]);

describe('project lifecycle transitions (US-2.4)', () => {
  it('accepts exactly the legal transitions and rejects everything else', () => {
    for (const from of ALL) {
      for (const to of ALL) {
        expect(isTransitionAllowed(from, to)).toBe(LEGAL.has(`${from}>${to}`));
      }
    }
  });

  it('rejects self-transitions (no duplicate publish)', () => {
    for (const s of ALL) expect(isTransitionAllowed(s, s)).toBe(false);
  });

  it('archived is terminal', () => {
    for (const to of ALL) expect(isTransitionAllowed('archived', to)).toBe(false);
  });
});
