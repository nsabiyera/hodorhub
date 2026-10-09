import { eq } from 'drizzle-orm';
import { z } from 'zod';
import { db as defaultDb } from '@/db';
import { agentDeliveryRuns, runBudgets, runMilestones, outbox, auditLog } from '@/db/schema';
import {
  findMembership,
  isPlatformAdmin,
  NotFoundError,
  ForbiddenError,
  InvalidStateError,
} from '@/modules/identity';
import { env } from '@/config/env';
import { PRICE_BOOK_VERSION } from './budget-math';
import { RUN_TERMINAL_STATUSES } from './run-status';

type Db = typeof defaultDb;
type Tx = Parameters<Parameters<Db['transaction']>[0]>[0];
type Executor = Db | Tx;

const PHASE_ORDER = ['requirements', 'design', 'build', 'delivery'] as const;
type Phase = (typeof PHASE_ORDER)[number];

/**
 * Called synchronously by Commitments when a charity accepts a compute pledge,
 * mirroring how acceptPledge calls Projects.beginDelivery — a cross-module
 * SERVICE call to the owning module, never a table write. Escrows the budget.
 */
export async function createRunFromPledge(
  exec: Executor,
  pledge: {
    id: string;
    projectId: string;
    corporationOrgId: string;
    templateCode: string;
    budgetCommittedMinor: number;
  },
  charityOrgId: string,
): Promise<{ runId: string }> {
  const [run] = await exec
    .insert(agentDeliveryRuns)
    .values({
      projectId: pledge.projectId,
      charityOrgId,
      corporationOrgId: pledge.corporationOrgId,
      computePledgeId: pledge.id,
      templateCode: pledge.templateCode,
      priceBookVersion: PRICE_BOOK_VERSION,
      provider: env.AGENT_DELIVERY_PROVIDER,
    })
    .returning({ id: agentDeliveryRuns.id });
  await exec
    .insert(runBudgets)
    .values({ runId: run!.id, committedMinor: pledge.budgetCommittedMinor });
  return { runId: run!.id };
}

/**
 * Emits the RunClosed outbox event when a run reaches a TERMINAL state
 * (completed/failed/halted). Billing (Release 2) subscribes to capture the
 * consumed budget and release the hold — no consumer wired yet in this slice.
 * Must run in the same tx as the state change.
 */
async function emitRunClosed(
  tx: Executor,
  run: { id: string; computePledgeId: string; corporationOrgId: string; priceBookVersion: string },
  outcome: 'completed' | 'failed' | 'halted',
) {
  const budget = await tx.query.runBudgets.findFirst({ where: eq(runBudgets.runId, run.id) });
  await tx.insert(outbox).values({
    eventType: 'RunClosed',
    payload: {
      runId: run.id,
      computePledgeId: run.computePledgeId,
      corporationOrgId: run.corporationOrgId,
      committedMinor: budget?.committedMinor ?? 0,
      consumedMinor: budget?.consumedMinor ?? 0,
      currency: budget?.currency ?? 'GBP',
      priceBookVersion: run.priceBookVersion,
      outcome,
    },
  });
}

/** Load a milestone as the charity owner of its run; cross-tenant → NotFound. */
async function loadMilestoneAsCharityOwner(exec: Executor, userId: string, milestoneId: string) {
  const ms = await exec.query.runMilestones.findFirst({ where: eq(runMilestones.id, milestoneId) });
  if (!ms) throw new NotFoundError('Milestone');
  const run = await exec.query.agentDeliveryRuns.findFirst({
    where: eq(agentDeliveryRuns.id, ms.runId),
  });
  if (!run) throw new NotFoundError('Milestone');
  const m = await findMembership(userId, run.charityOrgId, exec);
  if (!m) throw new NotFoundError('Milestone'); // no existence leak to another tenant
  if (m.role !== 'charity_owner') throw new ForbiddenError();
  return { ms, run };
}

/** US-11.3 — charity approves a phase; the next phase begins (or the run completes). */
export async function approveMilestone(
  actingUserId: string,
  milestoneId: string,
  db: Db = defaultDb,
): Promise<void> {
  await db.transaction(async (tx) => {
    const { ms, run } = await loadMilestoneAsCharityOwner(tx, actingUserId, milestoneId);
    if (ms.status !== 'awaiting_review')
      throw new InvalidStateError(`Milestone already ${ms.status}.`);
    await tx
      .update(runMilestones)
      .set({ status: 'approved', reviewerUserId: actingUserId, decidedAt: new Date() })
      .where(eq(runMilestones.id, milestoneId));
    const idx = PHASE_ORDER.indexOf(ms.phase as Phase);
    const next = PHASE_ORDER[idx + 1];
    if (next) {
      await tx
        .update(agentDeliveryRuns)
        .set({ currentPhase: next, status: 'authorized', updatedAt: new Date() })
        .where(eq(agentDeliveryRuns.id, ms.runId));
    } else {
      await tx
        .update(agentDeliveryRuns)
        .set({ status: 'completed', updatedAt: new Date() })
        .where(eq(agentDeliveryRuns.id, ms.runId));
      await emitRunClosed(tx, run, 'completed');
    }
    await tx.insert(outbox).values({
      eventType: 'MilestoneApproved',
      payload: { milestoneId, runId: ms.runId, phase: ms.phase },
    });
  });
}

/** US-11.3 — charity requests changes; the phase loops back to running for a revise cycle. */
export async function requestChanges(
  actingUserId: string,
  milestoneId: string,
  feedback: string,
  db: Db = defaultDb,
): Promise<void> {
  await db.transaction(async (tx) => {
    const { ms } = await loadMilestoneAsCharityOwner(tx, actingUserId, milestoneId);
    if (ms.status !== 'awaiting_review')
      throw new InvalidStateError(`Milestone already ${ms.status}.`);
    await tx
      .update(runMilestones)
      .set({
        status: 'changes_requested',
        reviewerUserId: actingUserId,
        reason: feedback,
        decidedAt: new Date(),
      })
      .where(eq(runMilestones.id, milestoneId));
    await tx
      .update(agentDeliveryRuns)
      .set({ status: 'running', updatedAt: new Date() })
      .where(eq(agentDeliveryRuns.id, ms.runId));
    await tx.insert(outbox).values({
      eventType: 'MilestoneChangesRequested',
      payload: { milestoneId, runId: ms.runId, phase: ms.phase },
    });
  });
}

/** US-11.3 — charity rejects; the run stops. */
export async function rejectMilestone(
  actingUserId: string,
  milestoneId: string,
  reason: string,
  db: Db = defaultDb,
): Promise<void> {
  await db.transaction(async (tx) => {
    const { ms, run } = await loadMilestoneAsCharityOwner(tx, actingUserId, milestoneId);
    if (ms.status !== 'awaiting_review')
      throw new InvalidStateError(`Milestone already ${ms.status}.`);
    await tx
      .update(runMilestones)
      .set({ status: 'rejected', reviewerUserId: actingUserId, reason, decidedAt: new Date() })
      .where(eq(runMilestones.id, milestoneId));
    await tx
      .update(agentDeliveryRuns)
      .set({ status: 'failed', updatedAt: new Date() })
      .where(eq(agentDeliveryRuns.id, ms.runId));
    await tx.insert(outbox).values({
      eventType: 'MilestoneRejected',
      payload: { milestoneId, runId: ms.runId, phase: ms.phase },
    });
    await emitRunClosed(tx, run, 'failed');
  });
}

/** Route body for the per-run admin control (US-11.5). */
export const runStatusSchema = z.object({
  status: z.enum(['paused', 'running', 'halted']),
});
export type RunStatusInput = z.infer<typeof runStatusSchema>;

/** US-11.5 — platform admin kill switch: pause/halt/resume a run. */
export async function setRunStatus(
  actingUserId: string,
  runId: string,
  status: 'paused' | 'running' | 'halted',
  db: Db = defaultDb,
): Promise<void> {
  await db.transaction(async (tx) => {
    if (!(await isPlatformAdmin(actingUserId, tx)))
      throw new ForbiddenError('Admin access required.');
    const run = await tx.query.agentDeliveryRuns.findFirst({
      where: eq(agentDeliveryRuns.id, runId),
    });
    if (!run) throw new NotFoundError('Run');
    if ((RUN_TERMINAL_STATUSES as readonly string[]).includes(run.status)) {
      throw new InvalidStateError(`Run is already ${run.status}; cannot change its status.`);
    }
    await tx
      .update(agentDeliveryRuns)
      .set({ status, updatedAt: new Date() })
      .where(eq(agentDeliveryRuns.id, runId));
    await tx.insert(auditLog).values({
      actorId: actingUserId,
      action: `agent_delivery.run.${status}`,
      entity: 'agent_delivery_run',
      entityId: runId,
      metadata: { status, previousStatus: run.status },
    });
    // charityOrgId/corporationOrgId ride along so the Notifications consumer can
    // resolve both parties without reading this module's tables (US-11.5 AC:
    // "the parties are notified").
    await tx.insert(outbox).values({
      eventType: 'RunStatusChanged',
      payload: {
        runId,
        status,
        by: actingUserId,
        charityOrgId: run.charityOrgId,
        corporationOrgId: run.corporationOrgId,
      },
    });
    if (status === 'halted') {
      await emitRunClosed(tx, run, 'halted');
    }
  });
}
