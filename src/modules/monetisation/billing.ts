import { and, eq, ne } from 'drizzle-orm';
import { z } from 'zod';
import { db as defaultDb } from '@/db';
import { plans, subscriptions } from '@/db/schema';
import {
  findMembership,
  NotFoundError,
  ForbiddenError,
  InvalidStateError,
} from '@/modules/identity';
import type { PaymentProviderClient, Invoice } from '@/lib/payment-provider';
import { getPlan, PLANS, DEFAULT_PLAN_CODE, type PlanCode } from './plans';

type Db = typeof defaultDb;
type Tx = Parameters<Parameters<Db['transaction']>[0]>[0];
type Executor = Db | Tx;

/** Route body for starting a subscription (US-10.6). Starter is free — nothing to buy. */
export const subscribeSchema = z.object({
  planCode: z.enum(
    PLANS.filter((p) => p.code !== DEFAULT_PLAN_CODE).map((p) => p.code) as unknown as [
      PlanCode,
      ...PlanCode[],
    ],
  ),
});
export type SubscribeInput = z.infer<typeof subscribeSchema>;

async function assertCsrManager(exec: Executor, userId: string, organisationId: string) {
  const m = await findMembership(userId, organisationId, exec);
  if (!m) throw new NotFoundError('Organisation'); // not a member → don't leak
  if (m.role !== 'csr_manager') throw new ForbiddenError('Only a CSR manager can do this.');
}

/**
 * The `plans` table exists only so `subscriptions.plan_id` has something to
 * point at; the catalogue in plans.ts is the source of truth. Materialising the
 * row on demand keeps the two from drifting and means no seed migration has to
 * be kept in step with the catalogue.
 */
async function ensurePlanRow(code: string, exec: Executor): Promise<string> {
  const plan = getPlan(code);
  if (!plan) throw new NotFoundError('Plan');
  const existing = await exec.query.plans.findFirst({ where: eq(plans.code, code) });
  if (existing) return existing.id;
  const [row] = await exec
    .insert(plans)
    .values({ code: plan.code, name: plan.name })
    .returning({ id: plans.id });
  return row!.id;
}

/**
 * US-10.6 — begin a subscription. Returns the provider's checkout URL and
 * writes NOTHING: entitlements must not change until money has actually moved,
 * so activation happens only on a verified provider callback.
 */
export async function startSubscription(
  actingUserId: string,
  organisationId: string,
  planCode: string,
  provider: PaymentProviderClient,
  returnUrl: string,
  db: Db = defaultDb,
): Promise<{ checkoutId: string; url: string }> {
  await assertCsrManager(db, actingUserId, organisationId);
  if (!getPlan(planCode)) throw new NotFoundError('Plan');
  if (planCode === DEFAULT_PLAN_CODE)
    throw new InvalidStateError('Starter is free — there is nothing to subscribe to.');
  return provider.createCheckout({ organisationId, planCode, returnUrl });
}

/**
 * US-10.6 — activate a subscription from a VERIFIED provider callback. The
 * caller must have obtained `confirmed` from `provider.verifyCheckoutCallback`,
 * which is where signature checking lives; this function trusts its argument
 * precisely because an unsigned body can never produce one.
 *
 * Idempotent: replaying the same callback (providers retry) supersedes the same
 * plan onto itself rather than stacking active subscriptions.
 */
export async function activateSubscription(
  confirmed: {
    organisationId: string;
    planCode: string;
    customerRef: string;
    subscriptionRef: string;
  },
  db: Db = defaultDb,
): Promise<{ planCode: string }> {
  return db.transaction(async (tx) => {
    const planId = await ensurePlanRow(confirmed.planCode, tx);
    // At most one active subscription per organisation: supersede any other.
    await tx
      .update(subscriptions)
      .set({ status: 'superseded', updatedAt: new Date() })
      .where(
        and(
          eq(subscriptions.organisationId, confirmed.organisationId),
          eq(subscriptions.status, 'active'),
          ne(subscriptions.subscriptionRef, confirmed.subscriptionRef),
        ),
      );
    const existing = await tx.query.subscriptions.findFirst({
      where: eq(subscriptions.subscriptionRef, confirmed.subscriptionRef),
    });
    if (existing) {
      await tx
        .update(subscriptions)
        .set({ status: 'active', planId, updatedAt: new Date() })
        .where(eq(subscriptions.id, existing.id));
    } else {
      await tx.insert(subscriptions).values({
        organisationId: confirmed.organisationId,
        planId,
        status: 'active',
        customerRef: confirmed.customerRef,
        subscriptionRef: confirmed.subscriptionRef,
      });
    }
    return { planCode: confirmed.planCode };
  });
}

/**
 * US-10.6 — cancel. The organisation falls back to Starter, which is exactly
 * what an absent active subscription already means, so nothing else has to
 * change for entitlements to revert.
 */
export async function cancelSubscription(
  actingUserId: string,
  organisationId: string,
  provider: PaymentProviderClient,
  db: Db = defaultDb,
): Promise<void> {
  await assertCsrManager(db, actingUserId, organisationId);
  const sub = await db.query.subscriptions.findFirst({
    where: and(
      eq(subscriptions.organisationId, organisationId),
      eq(subscriptions.status, 'active'),
    ),
  });
  if (!sub) throw new InvalidStateError('There is no active subscription to cancel.');
  if (sub.subscriptionRef) await provider.cancelSubscription(sub.subscriptionRef);
  await db
    .update(subscriptions)
    .set({ status: 'cancelled', updatedAt: new Date() })
    .where(eq(subscriptions.id, sub.id));
}

/**
 * US-10.6 — invoices, fetched from the provider rather than mirrored locally.
 * An organisation that has never paid has no customer at the provider, so the
 * honest answer is an empty list, not an error.
 */
export async function listInvoices(
  actingUserId: string,
  organisationId: string,
  provider: PaymentProviderClient,
  db: Db = defaultDb,
): Promise<Invoice[]> {
  await assertCsrManager(db, actingUserId, organisationId);
  const sub = await db.query.subscriptions.findFirst({
    where: eq(subscriptions.organisationId, organisationId),
  });
  if (!sub?.customerRef) return [];
  return provider.listInvoices(sub.customerRef);
}
