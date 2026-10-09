import { createServer } from 'node:http';
import PgBoss from 'pg-boss';
import { eq, inArray } from 'drizzle-orm';
// esbuild bundles this into dist/worker.cjs (ADR 0001); the `@` alias is
// resolved at bundle time (see build:workers). Since Slice 3a Task 6,
// @/modules/agent-delivery transitively imports Identity (for its typed
// errors), which pulls in @node-rs/argon2 — a native N-API module esbuild
// cannot bundle. build:workers marks it --external so it resolves via the
// normal node_modules require at runtime (same pattern as pg-native).
import { env } from '@/config/env';
import { db } from '@/db';
import { agentDeliveryRuns } from '@/db/schema';
import { relayOutbox } from '@/modules/notifications';
import { advanceRun, runProductionPromotion } from '@/modules/agent-delivery';
import { getModelProvider } from '@/lib/model-provider-factory';
import { getSandboxRunner } from '@/lib/sandbox-factory';
import { getDeployer } from '@/lib/deployer-factory';

const RELAY_INTERVAL_MS = 3000;
// Reconciliation sweep (belt-and-braces): catches runnable runs whose enqueue
// was lost (e.g. the relay fired an onAgentDeliveryEvent while the worker was
// down). Every 5 minutes is frequent enough without hammering the DB.
const RECONCILE_SWEEP_CRON = '*/5 * * * *';

// Cloud Run services must serve HTTP on $PORT; the worker has no real HTTP
// surface, so expose a tiny liveness endpoint to satisfy the platform while it
// runs the pg-boss loops + outbox relay (ADR 0002; CPU-always-allocated).
function startHealthServer() {
  const port = Number(process.env.PORT ?? 8080);
  createServer((_req, res) => {
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end('{"status":"ok"}');
  }).listen(port, () => console.warn(`[worker] health server on :${port}`));
}

/**
 * Background worker (ADR 0001): the "same code, different entrypoint" process
 * from ARCHITECTURE.md §8. Uses pg-boss (Postgres-backed) instead of Redis/BullMQ
 * so the MVP needs only one data store.
 *
 * Queues mirror the worker classes: ingestion → scoring → notifications.
 */
export const QUEUES = {
  ingest: 'engagement.ingest',
  score: 'scoring.recompute',
  notify: 'notifications.dispatch',
  // Agent-delivery (Epic 11, Slice 3): advance one run's current phase.
  agentAdvance: 'agent.advance',
  // Reconciliation sweep — enqueues agent.advance for any runnable run.
  agentAdvanceSweep: 'agent.advance.sweep',
  // Production promotion (US-11.8): the privileged deployer half of a charity
  // owner's explicit approval. Deliberately its own queue, not a phase of
  // agent.advance — the agents' path must have no route to a production deploy.
  agentPromote: 'agent.promote',
} as const;

async function main() {
  const boss = new PgBoss(env.DATABASE_URL);
  boss.on('error', (err) => console.error('[worker] pg-boss error', err));
  await boss.start();

  // pg-boss v10 requires a queue to exist before work()/schedule() (no implicit
  // creation). createQueue is idempotent.
  for (const queue of Object.values(QUEUES)) {
    await boss.createQueue(queue);
  }

  // Ingestion: normalise a raw social event → engagement_events (provisional).
  await boss.work(QUEUES.ingest, async ([job]) => {
    console.warn('[worker] ingest', job?.id); // TODO: normalise + insert (idempotent by externalEventId)
  });

  // Scoring: trust eval + anomaly check + recompute S/M (SUPPORT_SCORE_MODEL).
  await boss.work(QUEUES.score, async ([job]) => {
    console.warn('[worker] score', job?.id); // TODO: recompute project_scores, emit ScoreUpdated
  });

  // Notifications: fan out to in-app + email.
  await boss.work(QUEUES.notify, async ([job]) => {
    console.warn('[worker] notify', job?.id); // TODO: dispatch
  });

  // Agent-delivery (Epic 11, Slice 3): advance one run's current phase. Enqueued
  // by the relay hook below (on ComputePledgeAccepted/MilestoneApproved/
  // MilestoneChangesRequested/RunStatusChanged) and by the reconciliation sweep.
  // `singletonKey: runId` at send-time means a run has at most one pending
  // advance job, so this handler need not worry about concurrent advances of
  // the same run — advanceRun's own non-atomic-read caveat still applies
  // across *different* worker processes, which is out of scope for this slice.
  await boss.work<{ runId: string }>(QUEUES.agentAdvance, async ([job]) => {
    const runId = job?.data?.runId;
    if (!runId) return;
    const run = await db.query.agentDeliveryRuns.findFirst({
      where: eq(agentDeliveryRuns.id, runId),
    });
    if (!run) {
      console.warn('[worker] agent.advance: no such run', runId);
      return;
    }
    const provider = getModelProvider(run.provider); // real Anthropic provider when run.provider === 'anthropic' (selected via AGENT_DELIVERY_PROVIDER), fake otherwise; throws for any unknown name
    // Slice 3b Plan B1: sandbox/deployer are process-level, env-selected (via
    // AGENT_DELIVERY_SANDBOX / AGENT_DELIVERY_DEPLOYER, default 'fake' — so
    // nothing changes until an operator opts in), deliberately independent of
    // the per-run `run.provider` above. 'e2b'/'cloudrun' throw "not wired yet"
    // until Plan B2 supplies the real ArtifactStore + GCP deploy client.
    const deps = {
      sandbox: getSandboxRunner(env.AGENT_DELIVERY_SANDBOX ?? 'fake'),
      deployer: getDeployer(env.AGENT_DELIVERY_DEPLOYER ?? 'fake'),
    };
    const result = await advanceRun(runId, provider, db, deps);
    console.warn('[worker] agent.advance', runId, result.phase, result.status, result.ran);
  });

  // US-11.8 — production promotion. Enqueued only by the relay hook below, on
  // a ProductionPromotionRequested that a charity owner caused. `singletonKey:
  // promotionId` plus runProductionPromotion's own deploying-only guard means a
  // retry can never deploy the same promotion twice.
  await boss.work<{ promotionId: string }>(QUEUES.agentPromote, async ([job]) => {
    const promotionId = job?.data?.promotionId;
    if (!promotionId) return;
    const deployer = getDeployer(env.AGENT_DELIVERY_DEPLOYER ?? 'fake');
    const result = await runProductionPromotion(promotionId, deployer, db);
    console.warn('[worker] agent.promote', promotionId, result.status);
  });

  // Reconciliation sweep: belt-and-braces for a lost enqueue (e.g. the relay
  // fired onAgentDeliveryEvent while this queue was unavailable) — periodically
  // re-enqueue agent.advance for every still-runnable run. singletonKey collapses
  // this with any job already pending for the same run.
  await boss.schedule(QUEUES.agentAdvanceSweep, RECONCILE_SWEEP_CRON, {});
  await boss.work(QUEUES.agentAdvanceSweep, async () => {
    const runnable = await db.query.agentDeliveryRuns.findMany({
      where: inArray(agentDeliveryRuns.status, ['authorized', 'running']),
      columns: { id: true },
    });
    for (const run of runnable) {
      await boss.send(QUEUES.agentAdvance, { runId: run.id }, { singletonKey: run.id });
    }
    if (runnable.length > 0) {
      console.warn(`[worker] reconciliation enqueued ${runnable.length} run(s)`);
    }
  });

  // Periodic full recompute applies momentum decay (hourly).
  await boss.schedule(QUEUES.score, '0 * * * *', {});

  // Transactional-outbox relay (ARCHITECTURE.md §8): poll unpublished events and
  // dispatch them to the Notifications consumer, and (Slice 3a Task 6) enqueue
  // agent.advance for the runnable-making agent-delivery events.
  const onAgentDeliveryEvent = (runId: string) => {
    boss
      .send(QUEUES.agentAdvance, { runId }, { singletonKey: runId })
      .catch((err) => console.error('[worker] agent.advance enqueue error', err));
  };
  const onPromotionRequested = (promotionId: string) => {
    boss
      .send(QUEUES.agentPromote, { promotionId }, { singletonKey: promotionId })
      .catch((err) => console.error('[worker] agent.promote enqueue error', err));
  };
  setInterval(() => {
    relayOutbox(undefined, 100, onAgentDeliveryEvent, onPromotionRequested)
      .then((n) => {
        if (n > 0) console.warn(`[worker] relayed ${n} outbox event(s)`);
      })
      .catch((err) => console.error('[worker] relay error', err));
  }, RELAY_INTERVAL_MS);

  startHealthServer();
  console.warn('[worker] started; queues + outbox relay + agent-delivery wiring ready');
}

main().catch((err) => {
  console.error('[worker] fatal', err);
  process.exit(1);
});
