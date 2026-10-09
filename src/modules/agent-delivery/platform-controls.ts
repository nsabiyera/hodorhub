import { eq } from 'drizzle-orm';
import { z } from 'zod';
import { db as defaultDb } from '@/db';
import { platformControls, PLATFORM_CONTROLS_ID, auditLog, outbox } from '@/db/schema';
import { isPlatformAdmin, ForbiddenError } from '@/modules/identity';

type Db = typeof defaultDb;

/** Route body for the platform brake (US-11.5). */
export const platformBrakeSchema = z.object({ paused: z.boolean() });
export type PlatformBrakeInput = z.infer<typeof platformBrakeSchema>;

/**
 * US-11.5 — is the platform-wide agent-delivery brake engaged?
 *
 * An absent row means the brake has never been pulled → not paused. A thrown
 * read error is deliberately NOT swallowed: the caller must fail rather than
 * advance, so the brake can never fail open during exactly the database trouble
 * that might have prompted an operator to pull it.
 */
export async function isAgentDeliveryPaused(db: Db = defaultDb): Promise<boolean> {
  const row = await db.query.platformControls.findFirst({
    where: eq(platformControls.id, PLATFORM_CONTROLS_ID),
  });
  return row?.agentDeliveryPaused ?? false;
}

/**
 * US-11.5 — pull or release the platform-wide brake. Reversible by design: run
 * statuses are untouched, so every run resumes where it left off (via the
 * worker's reconciliation sweep, within RECONCILE_SWEEP_CRON) once released.
 *
 * Re-checks admin rights against the DATABASE rather than trusting the caller:
 * the route's requirePlatformAdmin() only reads the session cookie's claim
 * (tech-debt M4 — a 7-day cookie with no revocation).
 */
export async function setAgentDeliveryPaused(
  actingUserId: string,
  paused: boolean,
  db: Db = defaultDb,
): Promise<void> {
  await db.transaction(async (tx) => {
    if (!(await isPlatformAdmin(actingUserId, tx)))
      throw new ForbiddenError('Admin access required.');
    await tx
      .insert(platformControls)
      .values({ id: PLATFORM_CONTROLS_ID, agentDeliveryPaused: paused, updatedBy: actingUserId })
      .onConflictDoUpdate({
        target: platformControls.id,
        set: { agentDeliveryPaused: paused, updatedBy: actingUserId, updatedAt: new Date() },
      });
    await tx.insert(auditLog).values({
      actorId: actingUserId,
      action: paused ? 'agent_delivery.brake.pulled' : 'agent_delivery.brake.released',
      entity: 'platform_controls',
      entityId: null,
      metadata: { agentDeliveryPaused: paused },
    });
    await tx.insert(outbox).values({
      eventType: 'PlatformBrakeChanged',
      payload: { agentDeliveryPaused: paused, by: actingUserId },
    });
  });
}
