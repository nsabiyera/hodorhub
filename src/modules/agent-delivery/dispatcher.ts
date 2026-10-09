import { eq } from 'drizzle-orm';
import { db as defaultDb } from '@/db';
import { agentDeliveryRuns } from '@/db/schema';
import type { ModelProvider } from '@/lib/model-provider';
import type { SandboxRunner } from '@/lib/sandbox-runner';
import type { DeployerClient } from '@/lib/deployer';
import { NotFoundError, InvalidStateError } from '@/modules/identity';
import { runCurrentPhase } from './orchestrator';
import { runDeliveryPhase } from './delivery';
import { isAgentDeliveryPaused } from './platform-controls';

type Db = typeof defaultDb;

/**
 * Dispatcher: advance a run by running its current phase when it is in a
 * runnable state. A run is runnable when `authorized` (freshly authorised, or
 * a prior phase just approved → next phase) or `running` (a gate returned
 * changes-requested → re-run the current phase). Any other status
 * (awaiting_gate, completed, failed, halted, paused) is a no-op. Any advance
 * is also a no-op while the platform-wide brake is engaged (US-11.5).
 *
 * `currentPhase === 'delivery'` routes to the Deployer seam (runDeliveryPhase)
 * instead of the model-driven runCurrentPhase; every other phase is unchanged.
 *
 * Serial calls are safe (non-runnable statuses no-op correctly). NOT
 * concurrency-safe: it reads status then acts non-atomically, so a future
 * worker MUST guarantee a single consumer per run (e.g. SELECT ... FOR UPDATE
 * row-lock or a per-run queue key) to avoid two concurrent advances
 * double-spending.
 *
 * This is the logic a future pg-boss worker will call with a real provider
 * (Slice 3); here it is a plain, offline-testable service function.
 */
export async function advanceRun(
  runId: string,
  provider: ModelProvider,
  db: Db = defaultDb,
  deps: { sandbox?: SandboxRunner; deployer?: DeployerClient } = {},
): Promise<{ ran: boolean; status: string; phase: string }> {
  const run = await db.query.agentDeliveryRuns.findFirst({
    where: eq(agentDeliveryRuns.id, runId),
  });
  if (!run) throw new NotFoundError('Run');

  // US-11.5 — platform-wide brake. Checked here because advanceRun is the
  // single choke point for both the relay-driven enqueue and the reconciliation
  // sweep, so one check covers every path. A thrown read error propagates
  // (fail-safe): the pg-boss job retries rather than advancing.
  if (await isAgentDeliveryPaused(db)) {
    return { ran: false, status: run.status, phase: run.currentPhase };
  }

  const runnableStatus = run.status === 'authorized' || run.status === 'running';
  if (!runnableStatus) {
    return { ran: false, status: run.status, phase: run.currentPhase };
  }

  if (run.currentPhase === 'delivery') {
    if (!deps.deployer) throw new InvalidStateError('Delivery phase requires a deployer.');
    const r = await runDeliveryPhase(runId, deps.deployer, db);
    const after = await db.query.agentDeliveryRuns.findFirst({
      where: eq(agentDeliveryRuns.id, runId),
    });
    return {
      ran: r.status !== 'halted',
      status: after!.status,
      phase: after!.currentPhase,
    };
  }

  const result = await runCurrentPhase(runId, provider, db, { sandbox: deps.sandbox });
  const after = await db.query.agentDeliveryRuns.findFirst({
    where: eq(agentDeliveryRuns.id, runId),
  });
  return {
    ran: result.status !== 'skipped',
    status: after!.status,
    phase: after!.currentPhase,
  };
}
