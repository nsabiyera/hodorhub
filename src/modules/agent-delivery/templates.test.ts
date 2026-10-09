import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import {
  AGENT_DELIVERY_TEMPLATES,
  AGENT_DELIVERY_TEMPLATE_CODES,
  assertTemplateEligible,
  eligibleTemplatesFor,
  getTemplate,
  isTemplateEligible,
  TemplateNotEligibleError,
} from './templates';

describe('agent-delivery template allow-list (US-11.12)', () => {
  it('matches a project category the template is proven to deliver', () => {
    expect(isTemplateEligible('static-site', 'software')).toBe(true);
    expect(isTemplateEligible('static-site', 'design')).toBe(true);
    expect(isTemplateEligible('static-site', 'marketing')).toBe(true);
  });

  it('refuses project shapes the agents have not been proven on', () => {
    for (const category of ['construction', 'legal', 'events', 'fundraising', 'research']) {
      expect(isTemplateEligible('static-site', category)).toBe(false);
    }
  });

  it('refuses a template that is not on the allow-list at all', () => {
    expect(isTemplateEligible('mobile-app', 'software')).toBe(false);
    expect(getTemplate('mobile-app')).toBeUndefined();
  });

  it('refuses a project with no category', () => {
    expect(isTemplateEligible('static-site', null)).toBe(false);
    expect(isTemplateEligible('static-site', undefined)).toBe(false);
  });

  it('assertTemplateEligible throws a 422-mapped domain error, naming the category', () => {
    expect(() => assertTemplateEligible('static-site', 'construction')).toThrow(
      TemplateNotEligibleError,
    );
    try {
      assertTemplateEligible('static-site', 'construction');
      expect.unreachable();
    } catch (e) {
      expect((e as TemplateNotEligibleError).code).toBe('template_not_eligible');
      expect((e as Error).message).toContain('construction');
    }
    expect(() => assertTemplateEligible('static-site', 'software')).not.toThrow();
  });

  it('offers only the templates that can deliver a given category', () => {
    expect(eligibleTemplatesFor('software').map((t) => t.code)).toEqual(['static-site']);
    expect(eligibleTemplatesFor('construction')).toEqual([]);
    expect(eligibleTemplatesFor(null)).toEqual([]);
  });

  it('derives the codes tuple from the registry, so the zod enum cannot drift', () => {
    expect([...AGENT_DELIVERY_TEMPLATE_CODES]).toEqual(AGENT_DELIVERY_TEMPLATES.map((t) => t.code));
  });

  it('every template carries eval evidence for why it is allowed', () => {
    // The allow-list widens only as evals prove new shapes; an entry without
    // stated evidence is how that rule quietly erodes.
    for (const template of AGENT_DELIVERY_TEMPLATES) {
      expect(template.provenBy.length).toBeGreaterThan(20);
      expect(template.eligibleCategories.length).toBeGreaterThan(0);
    }
  });

  it('the allow-list is not restated anywhere else in the source', () => {
    // Before US-11.12 the list lived in three places that could drift. The
    // funding schema, the funding form and the project page must all read the
    // registry instead of hardcoding a template code.
    const files = [
      'src/modules/commitments/service.ts',
      'src/app/projects/[id]/FundAgentDeliveryForm.tsx',
      'src/app/projects/[id]/page.tsx',
    ];
    for (const f of files) {
      expect(readFileSync(f, 'utf8')).not.toMatch(/'static-site'/);
    }
  });
});
