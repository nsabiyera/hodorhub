import { and, eq } from 'drizzle-orm';
import { db as defaultDb } from '@/db';
import {
  agentDeliveryRuns,
  auditLog,
  deployedEnvironments,
  outbox,
  runMilestones,
} from '@/db/schema';
import type { DeployerClient } from '@/lib/deployer';
import {
  findMembership,
  NotFoundError,
  ForbiddenError,
  InvalidStateError,
} from '@/modules/identity';

type Db = typeof defaultDb;

/**
 * US-11.8 - the charity owner explicitly approves promoting the delivered app
 * from staging to production. This records INTENT ONLY: it writes a
 * `production` row in `deploying` and emits an event. The privileged deployer
 * runs later, in the worker (runProductionPromotion), so the web tier never
 * holds deploy credentials and a slow real deploy never sits under an HTTP
 * request.
 *
 * Charity-owner-only, re-checked against the database. A caller outside the
 * run's charity org gets NotFoundError rather than ForbiddenError, so run ids
 * never leak across tenants (same rule as loadMilestoneAsCharityOwner).
 */
export async function requestProductionPromotion(
  actingUserId: string,
  runId: string,
  db: Db = defaultDb,
): Promise<{ promotionId: string }> {
  return db.transaction(async (tx) => {
    const run = await tx.query.agentDeliveryRuns.findFirst({
      where: eq(agentDeliveryRuns.id, runId),
    });
    if (!run) throw new NotFoundError('Run');
    const membership = await findMembership(actingUserId, run.charityOrgId, tx);
    if (!membership) throw new NotFoundError('Run'); // no existence leak to another tenant
    if (membership.role !== 'charity_owner') throw new ForbiddenError();

    // "An approved app on staging" is exactly these two facts.
    const delivery = await tx.query.runMilestones.findFirst({
      where: and(eq(runMilestones.runId, runId), eq(runMilestones.phase, 'delivery')),
    });
    if (delivery?.status !== 'approved')
      throw new InvalidStateError('The delivery phase has not been approved yet.');

    const staging = await tx.query.deployedEnvironments.findFirst({
      where: and(
        eq(deployedEnvironments.runId, runId),
        eq(deployedEnvironments.environment, 'staging'),
        eq(deployedEnvironments.status, 'live'),
      ),
    });
    if (!staging) throw new InvalidStateError('There is no live staging deployment to promote.');

    // One promotion at a time, and never a silent re-promote. A `failed` row is
    // deliberately not a blocker: recovery is another explicit approval.
    const existing = await tx.query.deployedEnvironments.findFirst({
      where: and(
        eq(deployedEnvironments.runId, runId),
        eq(deployedEnvironments.environment, 'production'),
      ),
    });
    if (existing && (existing.status === 'deploying' || existing.status === 'live')) {
      throw new InvalidStateError(
        existing.status === 'live'
          ? 'This run is already promoted to production.'
          : 'A production promotion is already in progress.',
      );
    }

    const [promotion] = await tx
      .insert(deployedEnvironments)
      .values({
        runId,
        environment: 'production',
        status: 'deploying',
        promotedBy: actingUserId,
      })
      .returning({ id: deployedEnvironments.id });

    await tx.insert(auditLog).values({
      actorId: actingUserId,
      action: 'agent_delivery.promotion.requested',
      entity: 'agent_delivery_run',
      entityId: runId,
      metadata: { promotionId: promotion!.id, environment: 'production' },
    });
    // Org ids ride along so the worker's enqueue and the Notifications consumer
    // need not read this module's tables (same pattern as RunStatusChanged).
    await tx.insert(outbox).values({
      eventType: 'ProductionPromotionRequested',
      payload: {
        promotionId: promotion!.id,
        runId,
        by: actingUserId,
        charityOrgId: run.charityOrgId,
        corporationOrgId: run.corporationOrgId,
      },
    });
    return { promotionId: promotion!.id };
  });
}

/**
 * US-11.8 - the privileged deployer promotes an approved app to production.
 * Runs in the worker, out of every agent's reach: nothing on the agent path
 * (advanceRun -> runDeliveryPhase) can call this, which is what makes "the
 * agents never promote to production themselves" structural rather than a flag.
 *
 * Returns `skipped` unless the row is still `deploying`, so a pg-boss retry
 * after a partial success cannot deploy twice. A deploy failure marks the row
 * `failed` and rethrows: pg-boss records the failure, the next attempt is a
 * no-op, and recovery is a fresh, deliberate request from the charity.
 */
export async function runProductionPromotion(
  promotionId: string,
  deployer: DeployerClient,
  db: Db = defaultDb,
): Promise<{ status: 'live' | 'skipped' }> {
  const promotion = await db.query.deployedEnvironments.findFirst({
    where: eq(deployedEnvironments.id, promotionId),
  });
  if (!promotion) throw new NotFoundError('Promotion');
  if (promotion.status !== 'deploying') return { status: 'skipped' };

  const run = await db.query.agentDeliveryRuns.findFirst({
    where: eq(agentDeliveryRuns.id, promotion.runId),
  });
  if (!run) throw new NotFoundError('Run');

  // The artifact the charity approved on staging - never a fresh build.
  const build = await db.query.runMilestones.findFirst({
    where: and(eq(runMilestones.runId, promotion.runId), eq(runMilestones.phase, 'build')),
  });

  let deployed;
  try {
    // Outside any DB tx: it is an external call, like the model call.
    deployed = await deployer.deploy({
      runId: promotion.runId,
      environment: 'production',
      artifactRef: build?.artifactRef ?? 'unknown-artifact',
    });
  } catch (e) {
    await db
      .update(deployedEnvironments)
      .set({ status: 'failed' })
      .where(eq(deployedEnvironments.id, promotionId));
    throw e;
  }

  await db.transaction(async (tx) => {
    await tx
      .update(deployedEnvironments)
      .set({
        status: 'live',
        url: deployed.url,
        revisionRef: deployed.revisionRef,
        deployedAt: new Date(),
      })
      .where(eq(deployedEnvironments.id, promotionId));
    await tx.insert(auditLog).values({
      // The promoter is the accountable actor, not the worker that carried it out.
      actorId: promotion.promotedBy,
      action: 'agent_delivery.promotion.deployed',
      entity: 'agent_delivery_run',
      entityId: promotion.runId,
      metadata: { promotionId, url: deployed.url, revisionRef: deployed.revisionRef },
    });
    await tx.insert(outbox).values({
      eventType: 'ProductionPromoted',
      payload: {
        promotionId,
        runId: promotion.runId,
        url: deployed.url,
        by: promotion.promotedBy,
        charityOrgId: run.charityOrgId,
        corporationOrgId: run.corporationOrgId,
      },
    });
  });

  return { status: 'live' };
}
