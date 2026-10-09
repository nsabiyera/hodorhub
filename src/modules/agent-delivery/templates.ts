import { DomainError } from '@/modules/identity';

/**
 * US-11.12 — the eligible-template allow-list: the single source of truth for
 * what agent delivery may attempt. AgentDelivery owns it because it owns what
 * the agents can actually build.
 *
 * `eligibleCategories` is the matching rule. A project's category is the shape
 * signal the domain has, and it is required at publish (US-2.6) while funding
 * only happens on published projects — so it is always present at the check.
 *
 * DELIBERATELY CODE, NOT AN ADMIN TOGGLE. The story's second clause is a
 * governance rule: the allow-list "widens only as evals prove new shapes". A
 * runtime switch would be exactly the way to widen it without evals. Adding a
 * template — or a category to an existing one — is a reviewed pull request that
 * carries its evidence in `provenBy`. Admins get a read-only view of this
 * registry at GET /api/admin/agent-delivery/templates.
 */
export const AGENT_DELIVERY_TEMPLATES = [
  {
    code: 'static-site',
    label: 'Static site',
    eligibleCategories: ['software', 'design', 'marketing'],
    provenBy:
      'Epic 11 Slice 3a/3b: requirements -> design -> build -> staging delivery driven end to end on this shape. Widen only with comparable evidence for a new shape.',
  },
] as const;

export type AgentDeliveryTemplate = (typeof AGENT_DELIVERY_TEMPLATES)[number];
export type AgentDeliveryTemplateCode = AgentDeliveryTemplate['code'];

/**
 * Template codes as a non-empty tuple, so `z.enum` can be derived from the
 * registry rather than restating it. Schema and allow-list cannot drift.
 */
export const AGENT_DELIVERY_TEMPLATE_CODES = AGENT_DELIVERY_TEMPLATES.map(
  (t) => t.code,
) as unknown as [AgentDeliveryTemplateCode, ...AgentDeliveryTemplateCode[]];

export function getTemplate(code: string): AgentDeliveryTemplate | undefined {
  return AGENT_DELIVERY_TEMPLATES.find((t) => t.code === code);
}

/** Does this template cover a project of this category? */
export function isTemplateEligible(code: string, category: string | null | undefined): boolean {
  const template = getTemplate(code);
  if (!template || !category) return false;
  return (template.eligibleCategories as readonly string[]).includes(category);
}

/**
 * The templates that can deliver a project of this category — drives the
 * funding UI, so a corporation is never offered a template that would be
 * rejected at 422.
 */
export function eligibleTemplatesFor(
  category: string | null | undefined,
): readonly AgentDeliveryTemplate[] {
  if (!category) return [];
  return AGENT_DELIVERY_TEMPLATES.filter((t) =>
    (t.eligibleCategories as readonly string[]).includes(category),
  );
}

/**
 * US-11.12 — raised when a funding attempt names a template that cannot deliver
 * this project. 422, not 400: the request is well formed, but this project is
 * not a shape the agents have been proven to deliver.
 */
export class TemplateNotEligibleError extends DomainError {
  constructor(code: string, category: string | null | undefined) {
    super(
      category
        ? `Agent delivery with the "${code}" template is not available for ${category} projects.`
        : `Agent delivery is not available for a project without a category.`,
      'template_not_eligible',
    );
  }
}

/** Guard for the funding choke point. */
export function assertTemplateEligible(code: string, category: string | null | undefined): void {
  if (!isTemplateEligible(code, category)) throw new TemplateNotEligibleError(code, category);
}
