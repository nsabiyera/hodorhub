import { and, desc, eq } from 'drizzle-orm';
import { db as defaultDb } from '@/db';
import { agentDeliveryRuns, runMilestones, deployedEnvironments } from '@/db/schema';
import { getBalance } from './budget';

type Db = typeof defaultDb;

const PHASE_ORDER = ['requirements', 'design', 'build', 'delivery'] as const;

/** Run detail for the project page. Unauthenticated read — the page gates display by role. */
export async function getRunForProject(projectId: string, db: Db = defaultDb) {
  const run = await db.query.agentDeliveryRuns.findFirst({
    where: eq(agentDeliveryRuns.projectId, projectId),
    orderBy: [desc(agentDeliveryRuns.createdAt)],
  });
  if (!run) return null;
  const milestones = await db.query.runMilestones.findMany({
    where: eq(runMilestones.runId, run.id),
  });
  milestones.sort(
    (a, b) => PHASE_ORDER.indexOf(a.phase as never) - PHASE_ORDER.indexOf(b.phase as never),
  );
  const budget = await getBalance(db, run.id);
  // Staging and production are read separately (US-11.8). A single findFirst
  // over "any live row" became ambiguous the moment a run could have two.
  const staging =
    (await db.query.deployedEnvironments.findFirst({
      where: and(
        eq(deployedEnvironments.runId, run.id),
        eq(deployedEnvironments.environment, 'staging'),
        eq(deployedEnvironments.status, 'live'),
      ),
    })) ?? null;
  // Not filtered to 'live': the panel shows an in-flight promotion too, and a
  // failed one is why a charity owner may approve again.
  const production =
    (await db.query.deployedEnvironments.findFirst({
      where: and(
        eq(deployedEnvironments.runId, run.id),
        eq(deployedEnvironments.environment, 'production'),
      ),
      orderBy: [desc(deployedEnvironments.createdAt)],
    })) ?? null;
  return { run, milestones, budget, staging, production };
}

/**
 * US-7.1 — every agent-delivery run this corporation funded, with what it
 * actually spent. Reported in its own units (runs and currency) because agent
 * delivery is a parallel path to donated time, never a substitute expressible
 * in hours (US-11.9).
 *
 * Unauthorised by design, like getRunForProject: the caller (Reporting) has
 * already established that the actor is a CSR manager of this organisation.
 */
export async function getRunsForCorporation(corporationOrgId: string, db: Db = defaultDb) {
  const runs = await db.query.agentDeliveryRuns.findMany({
    where: eq(agentDeliveryRuns.corporationOrgId, corporationOrgId),
  });
  return Promise.all(
    runs.map(async (run) => ({
      runId: run.id,
      projectId: run.projectId,
      status: run.status,
      phase: run.currentPhase,
      budget: await getBalance(db, run.id),
    })),
  );
}
