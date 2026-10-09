import { and, eq } from 'drizzle-orm';
import { db as defaultDb } from '@/db';
import { agentDeliveryRuns, runMilestones, agentSteps } from '@/db/schema';
import type { ModelProvider, ModelTier } from '@/lib/model-provider';
import type { SandboxRunner } from '@/lib/sandbox-runner';
import { InvalidStateError } from '@/modules/identity';
import { estimateMaxCostMinor, actualCostMinor } from './budget-math';
import { reserveStep, settleStep, releaseReservation } from './budget';
import { BudgetExceededError } from './errors';

// Re-exported so callers (and this task's test fixture) can treat the gate
// as part of the orchestrator's surface; the implementation lives in
// ./service.ts alongside createRunFromPledge, per the module's tx/authz rules.
export { approveMilestone, requestChanges, rejectMilestone } from './service';

type Db = typeof defaultDb;

type RunnablePhase = 'requirements' | 'design' | 'build';

interface PhaseSpec {
  tier: ModelTier;
  maxOutput: number;
  promptTokens: number; // conservative fixed estimate for reservation
  build: (templateCode: string, priorArtifact: string | null) => { system: string; prompt: string };
}

const PHASE_SPECS: Record<RunnablePhase, PhaseSpec> = {
  requirements: {
    tier: 'planner',
    maxOutput: 2000,
    promptTokens: 1200,
    build: (templateCode) => ({
      system: 'You are the requirements planner. Emit machine-checkable acceptance criteria.',
      prompt: `Produce given/when/then acceptance criteria for template ${templateCode}.`,
    }),
  },
  design: {
    tier: 'planner',
    maxOutput: 3000,
    promptTokens: 1800,
    build: (templateCode, priorArtifact) => ({
      system: 'You are the design planner. Produce an architecture and task plan.',
      prompt:
        `Given these approved acceptance criteria:\n${priorArtifact ?? '(none)'}\n\n` +
        `Produce the architecture and implementation task plan for template ${templateCode}.`,
    }),
  },
  build: {
    tier: 'worker',
    maxOutput: 8000,
    promptTokens: 4000,
    build: (templateCode, priorArtifact) => ({
      system: 'You are the build worker. Implement the design as code with tests.',
      prompt: `Implement template ${templateCode} to satisfy this approved design:\n${priorArtifact ?? '(none)'}`,
    }),
  },
};

const PRIOR_PHASE: Partial<Record<RunnablePhase, 'requirements' | 'design'>> = {
  design: 'requirements',
  build: 'design',
};

function isRunnablePhase(p: string): p is RunnablePhase {
  return p === 'requirements' || p === 'design' || p === 'build';
}

/**
 * Runs whichever phase `run.currentPhase` names, metered by the budget.
 * Deterministic control flow; the model is the only non-deterministic part.
 * - paused/halted run → 'halted' (no work).
 * - Handles requirements/design/build only. Delivery is a separate runner
 *   (`runDeliveryPhase` in ./delivery.ts) — the dispatcher routes
 *   currentPhase==='delivery' there directly, before this function is
 *   reached, so 'skipped' is unused for the current phase set (no phase
 *   without a runner exists today).
 * - an already-approved phase → InvalidStateError (no re-run).
 * - affordability/kill-switch checked BEFORE the model call (US-11.4/11.5).
 * - a thrown model call releases the reservation and halts (no stranded budget).
 */
export async function runCurrentPhase(
  runId: string,
  provider: ModelProvider,
  db: Db = defaultDb,
  deps: { sandbox?: SandboxRunner } = {},
): Promise<{ milestoneId: string; status: 'awaiting_review' | 'halted' | 'skipped' }> {
  const run = await db.query.agentDeliveryRuns.findFirst({
    where: eq(agentDeliveryRuns.id, runId),
  });
  if (!run) throw new Error(`No run ${runId}`);
  if (run.status === 'paused' || run.status === 'halted') {
    return { milestoneId: '', status: 'halted' };
  }
  if (!isRunnablePhase(run.currentPhase)) {
    return { milestoneId: '', status: 'skipped' };
  }
  const phase = run.currentPhase;

  const already = await db.query.runMilestones.findFirst({
    where: and(eq(runMilestones.runId, runId), eq(runMilestones.phase, phase)),
  });
  if (already?.status === 'approved') {
    throw new InvalidStateError(`Phase ${phase} already approved.`);
  }
  if (phase === 'build' && !deps.sandbox) {
    throw new InvalidStateError('Build phase requires a sandbox runner.');
  }

  const spec = PHASE_SPECS[phase];
  // Prior artifact embedded in this phase's prompt is bounded by the prior
  // phase's output cap, so reserve input against scaffolding + that cap. This
  // keeps reserved cost >= actual on INPUT as well as OUTPUT (Plan B1).
  const priorPhase = PRIOR_PHASE[phase];
  const priorMaxOutput = priorPhase ? PHASE_SPECS[priorPhase].maxOutput : 0;
  const reservedPromptTokens = spec.promptTokens + priorMaxOutput;
  const estimate = estimateMaxCostMinor(spec.tier, reservedPromptTokens, spec.maxOutput);

  // Reserve first, in its own tx. If it can't be afforded, halt — no model call.
  try {
    await db.transaction(async (tx) => {
      await tx
        .update(agentDeliveryRuns)
        .set({ status: 'running', updatedAt: new Date() })
        .where(eq(agentDeliveryRuns.id, runId));
      await reserveStep(tx, runId, estimate);
    });
  } catch (e) {
    if (e instanceof BudgetExceededError) {
      // Record the halt reason as an error step (audit symmetry with the
      // model-throw path) and halt. The reserve tx already rolled back, so
      // there is no reservation to release.
      await db.transaction(async (tx) => {
        await tx.insert(agentSteps).values({
          runId,
          phase,
          role: spec.tier,
          stepIndex: 0,
          status: 'error',
          error: 'Budget exceeded: cannot afford the next step.',
        });
        await tx
          .update(agentDeliveryRuns)
          .set({ status: 'halted', updatedAt: new Date() })
          .where(eq(agentDeliveryRuns.id, runId));
      });
      return { milestoneId: '', status: 'halted' };
    }
    throw e;
  }

  // Design reads the approved requirements artifact; build reads the approved design artifact.
  // (priorPhase computed above, next to the reservation estimate.)
  let priorArtifact: string | null = null;
  if (priorPhase) {
    const prev = await db.query.runMilestones.findFirst({
      where: and(eq(runMilestones.runId, runId), eq(runMilestones.phase, priorPhase)),
    });
    priorArtifact = prev?.artifactRef ?? null;
  }
  const { system, prompt } = spec.build(run.templateCode, priorArtifact);

  let response;
  try {
    response = await provider.complete({
      tier: spec.tier,
      system,
      prompt,
      maxOutputTokens: spec.maxOutput,
    });
  } catch (err) {
    // Release the reservation so a failed model call never strands budget.
    await db.transaction(async (tx) => {
      await releaseReservation(tx, runId, estimate);
      await tx.insert(agentSteps).values({
        runId,
        phase,
        role: spec.tier,
        stepIndex: 0,
        status: 'error',
        error: err instanceof Error ? err.message : String(err),
      });
      await tx
        .update(agentDeliveryRuns)
        .set({ status: 'halted', updatedAt: new Date() })
        .where(eq(agentDeliveryRuns.id, runId));
    });
    return { milestoneId: '', status: 'halted' };
  }

  const actual = actualCostMinor(spec.tier, response.usage);

  // For build, run the sandbox against the model's code and fold the result
  // into the artifact text. The sandbox's presence was already checked before
  // the reservation was made, so it is guaranteed to be here.
  let artifactText = response.text;
  if (phase === 'build') {
    const sandbox = deps.sandbox!;
    const built = await sandbox.runBuild({
      templateCode: run.templateCode,
      designArtifact: priorArtifact,
      code: response.text,
    });
    artifactText = `${built.artifactRef}\ntests: ${built.testsPassed ? 'passed' : 'FAILED'}\n${built.log}`;
  }

  return db.transaction(async (tx) => {
    await settleStep(tx, runId, estimate, actual, {
      model: response.modelId,
      inputTokens: response.usage.inputTokens,
      outputTokens: response.usage.outputTokens,
    });
    await tx.insert(agentSteps).values({
      runId,
      phase,
      role: spec.tier,
      stepIndex: 0,
      inputTokens: response.usage.inputTokens,
      outputTokens: response.usage.outputTokens,
      costMinor: actual,
      status: 'ok',
    });
    const [ms] = await tx
      .insert(runMilestones)
      .values({
        runId,
        phase,
        status: 'awaiting_review',
        artifactRef: artifactText,
        openedAt: new Date(),
      })
      .onConflictDoUpdate({
        target: [runMilestones.runId, runMilestones.phase],
        set: {
          status: 'awaiting_review',
          artifactRef: artifactText,
          openedAt: new Date(),
          reason: null,
          decidedAt: null,
        },
      })
      .returning({ id: runMilestones.id });
    // Compare-and-set: only running → awaiting_gate. If an admin paused/halted
    // the run during the (untransacted, minutes-long) model call, the kill
    // switch must win — we do NOT overwrite it back to awaiting_gate (US-11.5).
    const advanced = await tx
      .update(agentDeliveryRuns)
      .set({ status: 'awaiting_gate', updatedAt: new Date() })
      .where(and(eq(agentDeliveryRuns.id, runId), eq(agentDeliveryRuns.status, 'running')))
      .returning({ id: agentDeliveryRuns.id });
    const killedMidPhase = advanced.length === 0;
    return {
      milestoneId: ms!.id,
      status: killedMidPhase ? ('halted' as const) : ('awaiting_review' as const),
    };
  });
}

/** Backward-compatible wrapper — Slice 1 callers/tests use this at the requirements phase. */
export async function runRequirementsPhase(
  runId: string,
  provider: ModelProvider,
  db: Db = defaultDb,
): Promise<{ milestoneId: string; status: 'awaiting_review' | 'halted' }> {
  const r = await runCurrentPhase(runId, provider, db);
  return { milestoneId: r.milestoneId, status: r.status === 'skipped' ? 'halted' : r.status };
}
