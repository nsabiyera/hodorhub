import { and, eq } from 'drizzle-orm';
import { db as defaultDb } from '@/db';
import { entitlements, organisations, plans, subscriptions } from '@/db/schema';
import { NotFoundError, countMembers } from '@/modules/identity';
import {
  DEFAULT_PLAN_CODE,
  getPlan,
  nextPlanWithMoreSeats,
  type Feature,
  type Plan,
} from './plans';
import { PlanUpgradeRequiredError, SeatLimitReachedError } from './errors';

type Db = typeof defaultDb;
type Tx = Parameters<Parameters<Db['transaction']>[0]>[0];
type Executor = Db | Tx;

/**
 * US-10.2 — the plan an organisation is on. An absent subscription row means
 * Starter rather than "no plan": a corporation is never in a state where the
 * platform cannot answer what it is entitled to, and no backfill was needed for
 * the organisations that existed before plans were wired up.
 */
export async function getPlanForOrg(
  organisationId: string,
  exec: Executor = defaultDb,
): Promise<Plan> {
  const sub = await exec.query.subscriptions.findFirst({
    where: and(
      eq(subscriptions.organisationId, organisationId),
      eq(subscriptions.status, 'active'),
    ),
  });
  if (!sub) return getPlan(DEFAULT_PLAN_CODE)!;
  const row = await exec.query.plans.findFirst({ where: eq(plans.id, sub.planId) });
  // A subscription pointing at a plan code the catalogue no longer knows falls
  // back to Starter rather than throwing: losing a feature is recoverable, a
  // 500 on every gated request is not.
  return getPlan(row?.code ?? '') ?? getPlan(DEFAULT_PLAN_CODE)!;
}

/**
 * US-10.1 — the single question every gated feature asks. Never compare plan
 * codes at a call site; ask this.
 *
 * US-10.3 is enforced here, at the root: a charity is ALWAYS entitled. Cost is
 * never a barrier to beneficiaries or the public, so there is no code path in
 * which a charity or supporter can be refused a feature for lack of a plan —
 * and putting that rule here means it cannot be forgotten at a call site.
 *
 * Resolution order: charity → always; per-organisation entitlement row (the
 * US-10.8 seam for comps and grants) → granted; otherwise the plan catalogue.
 */
export async function hasEntitlement(
  organisationId: string,
  feature: Feature,
  exec: Executor = defaultDb,
): Promise<boolean> {
  const org = await exec.query.organisations.findFirst({
    where: eq(organisations.id, organisationId),
  });
  if (!org) throw new NotFoundError('Organisation');
  if (org.type !== 'corporation') return true; // US-10.3

  const granted = await exec.query.entitlements.findFirst({
    where: and(eq(entitlements.organisationId, organisationId), eq(entitlements.feature, feature)),
  });
  if (granted) return true;

  const plan = await getPlanForOrg(organisationId, exec);
  return (plan.features as readonly string[]).includes(feature);
}

/**
 * US-10.5 — everything a CSR dashboard or upgrade prompt needs in one read:
 * the current plan, what it includes, and the per-org grants layered on top.
 */
export async function getEntitlementSummary(organisationId: string, exec: Executor = defaultDb) {
  const org = await exec.query.organisations.findFirst({
    where: eq(organisations.id, organisationId),
  });
  if (!org) throw new NotFoundError('Organisation');
  const plan = await getPlanForOrg(organisationId, exec);
  const granted = await exec.query.entitlements.findMany({
    where: eq(entitlements.organisationId, organisationId),
  });
  const grantedFeatures = granted.map((g) => g.feature);
  return {
    planCode: plan.code,
    planName: plan.name,
    seatLimit: plan.seatLimit,
    features: [...new Set([...plan.features, ...grantedFeatures])],
    grantedFeatures,
  };
}

/**
 * US-10.5 — the gate. Throws PlanUpgradeRequiredError (402) rather than
 * returning false, so a caller cannot forget to handle the negative case, and
 * so the response carries the plan the CSR manager actually needs.
 */
export async function assertEntitlement(
  organisationId: string,
  feature: Feature,
  exec: Executor = defaultDb,
): Promise<void> {
  if (!(await hasEntitlement(organisationId, feature, exec)))
    throw new PlanUpgradeRequiredError(feature);
}

/**
 * US-10.7 — seats used against the plan's limit. `seatLimit: null` is
 * unlimited (Enterprise), reported as a null limit rather than a large number
 * so a caller cannot accidentally compare against a sentinel.
 */
export async function getSeatUsage(organisationId: string, exec: Executor = defaultDb) {
  const org = await exec.query.organisations.findFirst({
    where: eq(organisations.id, organisationId),
  });
  if (!org) throw new NotFoundError('Organisation');
  const plan = await getPlanForOrg(organisationId, exec);
  const used = await countMembers(organisationId, exec);
  // US-10.3 — a charity has no seat limit, as it has no plan limits at all.
  const seatLimit = org.type === 'corporation' ? plan.seatLimit : null;
  return {
    used,
    seatLimit,
    remaining: seatLimit === null ? null : Math.max(0, seatLimit - used),
    planName: plan.name,
  };
}

/**
 * US-10.7 — the gate before adding a member. Charities and unlimited plans pass
 * straight through. Called by the invite route BEFORE inviteMember, which stays
 * the unguarded primitive so that seeding and tests can build fixtures without
 * tripping a plan limit (the same split as Projects.beginDelivery, tech-debt M1).
 */
export async function assertSeatAvailable(
  organisationId: string,
  exec: Executor = defaultDb,
): Promise<void> {
  const usage = await getSeatUsage(organisationId, exec);
  if (usage.seatLimit === null || usage.used < usage.seatLimit) return;
  const next = nextPlanWithMoreSeats(usage.seatLimit);
  throw new SeatLimitReachedError(
    usage.seatLimit,
    next ? { code: next.code, name: next.name } : null,
  );
}
