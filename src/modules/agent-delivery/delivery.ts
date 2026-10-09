import { and, eq, sql } from 'drizzle-orm';
import { db as defaultDb } from '@/db';
import { agentDeliveryRuns, runMilestones, deployedEnvironments } from '@/db/schema';
import type { DeployerClient } from '@/lib/deployer';
import { InvalidStateError } from '@/modules/identity';

type Db = typeof defaultDb;

/**
 * Delivery phase: deploy the approved build artifact to a STAGING url via the
 * privileged Deployer (out-of-agent), record the environment, and open the
 * delivery gate for the charity (US-11.7). No model call, no budget reservation
 * — deploy has no token cost. Production promotion (US-11.8) is a separate gate.
 */
export async function runDeliveryPhase(
  runId: string,
  deployer: DeployerClient,
  db: Db = defaultDb,
): Promise<{ milestoneId: string; status: 'awaiting_review' | 'halted' }> {
  const run = await db.query.agentDeliveryRuns.findFirst({
    where: eq(agentDeliveryRuns.id, runId),
  });
  if (!run) throw new Error(`No run ${runId}`);
  if (run.status === 'paused' || run.status === 'halted')
    return { milestoneId: '', status: 'halted' };
  if (run.currentPhase !== 'delivery')
    throw new InvalidStateError(`Run is not in the delivery phase (${run.currentPhase}).`);

  const build = await db.query.runMilestones.findFirst({
    where: and(eq(runMilestones.runId, runId), eq(runMilestones.phase, 'build')),
  });
  const artifactRef = build?.artifactRef ?? 'unknown-artifact';

  // Deploy happens outside any DB tx (it's an external call, like the model call).
  const deployed = await deployer.deploy({ runId, environment: 'staging', artifactRef });

  return db.transaction(async (tx) => {
    // Supersede any prior live deployment for this run+environment before
    // recording the new one, so a changes-requested → re-deploy cycle never
    // accumulates more than one 'live' row per run.
    await tx
      .update(deployedEnvironments)
      .set({ status: 'torn_down', tornDownAt: new Date() })
      .where(
        and(
          eq(deployedEnvironments.runId, runId),
          eq(deployedEnvironments.environment, 'staging'),
          eq(deployedEnvironments.status, 'live'),
        ),
      );
    await tx.insert(deployedEnvironments).values({
      runId,
      environment: 'staging',
      url: deployed.url,
      revisionRef: deployed.revisionRef,
      status: 'live',
      deployedAt: new Date(),
    });
    const [ms] = await tx
      .insert(runMilestones)
      .values({
        runId,
        phase: 'delivery',
        status: 'awaiting_review',
        artifactRef: deployed.url,
        openedAt: new Date(),
      })
      .onConflictDoUpdate({
        target: [runMilestones.runId, runMilestones.phase],
        set: {
          status: 'awaiting_review',
          artifactRef: deployed.url,
          openedAt: new Date(),
          reason: null,
          decidedAt: null,
        },
      })
      .returning({ id: runMilestones.id });
    // CAS: only running/authorized → awaiting_gate (kill switch wins). Delivery
    // is entered from `authorized` (post-build-approval) and may pass through
    // `running`; paused/halted are deliberately excluded.
    const advanced = await tx
      .update(agentDeliveryRuns)
      .set({ status: 'awaiting_gate', updatedAt: new Date() })
      .where(
        and(
          eq(agentDeliveryRuns.id, runId),
          sql`${agentDeliveryRuns.status} in ('running','authorized')`,
        ),
      )
      .returning({ id: agentDeliveryRuns.id });
    return {
      milestoneId: ms!.id,
      status: advanced.length === 0 ? ('halted' as const) : ('awaiting_review' as const),
    };
  });
}
