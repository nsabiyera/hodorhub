/**
 * US-10.1 — the plan catalogue: the single place that says what each plan
 * includes. Features are gated by asking `hasEntitlement(org, feature)`, never
 * by a scattered `if (plan === 'team')`.
 *
 * DELIBERATELY CODE, like the agent-delivery template allow-list. Pricing and
 * comps that an admin manages at runtime are US-10.8 (a *Could*), and the
 * per-organisation `entitlements` table is already the seam for them: a row
 * there grants a feature the plan does not, which is how a grant-funded or
 * complimentary account will work without editing this catalogue.
 */
export const FEATURES = {
  /** The cross-project CSR dashboard (US-7.1). */
  csrDashboard: 'csr_dashboard',
  /** Corporate logo and theme on tenant surfaces (US-10.12). */
  branding: 'branding',
  /** Custom domain with automatic TLS (US-10.13). */
  customDomain: 'custom_domain',
} as const;

export type Feature = (typeof FEATURES)[keyof typeof FEATURES];

export const PLANS = [
  {
    code: 'starter',
    name: 'Starter',
    /** Free, and enough to run the whole core loop (US-10.2). */
    features: [] as Feature[],
    seatLimit: 5,
  },
  {
    code: 'team',
    name: 'Team',
    features: [FEATURES.csrDashboard, FEATURES.branding] as Feature[],
    seatLimit: 50,
  },
  {
    code: 'enterprise',
    name: 'Enterprise',
    features: [FEATURES.csrDashboard, FEATURES.branding, FEATURES.customDomain] as Feature[],
    seatLimit: null, // unlimited
  },
] as const;

export type Plan = (typeof PLANS)[number];
export type PlanCode = Plan['code'];

/**
 * The plan every corporation starts on (US-10.2). An organisation with no
 * subscription row IS on Starter — absent means default, so no backfill is
 * needed and a corporation can never end up with no plan at all.
 */
export const DEFAULT_PLAN_CODE: PlanCode = 'starter';

export function getPlan(code: string): Plan | undefined {
  return PLANS.find((p) => p.code === code);
}

/** The plan a feature first becomes available on — used for upgrade prompts (US-10.5). */
export function lowestPlanWith(feature: Feature): Plan | undefined {
  return PLANS.find((p) => (p.features as readonly string[]).includes(feature));
}

/** The next plan up that allows more seats than `seatLimit` — for upgrade prompts. */
export function nextPlanWithMoreSeats(seatLimit: number): Plan | undefined {
  return PLANS.find((p) => p.seatLimit === null || p.seatLimit > seatLimit);
}
