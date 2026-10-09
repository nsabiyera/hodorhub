# Agent-Delivery Slice 2 — Dispatcher, Design phase & reservation release

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Extend the merged Agent Delivery foundation so a run progresses through multiple human-gated phases automatically (requirements → gate → design → gate), recovers budget when a step fails, and can be driven by a single dispatcher call — all still against the fake provider, fully verifiable offline.

**Architecture:** Generalize the single-phase orchestrator into a phase-driven runner with a phase guard; add the Design phase (planner tier, reads the approved requirements artifact); add a budget `releaseReservation` path and release-on-failure so a thrown model call never strands a reservation; add an `advanceRun` dispatcher that runs the current phase when a run is in a runnable state (post-authorize or post-changes-requested). The pg-boss worker/relay wiring that calls `advanceRun` with a *real* provider is deferred to Slice 3 (it needs the real provider and isn't offline-testable).

**Tech Stack:** TypeScript (ESM, `@/` alias), Drizzle/Postgres, Vitest (unit `vitest.config.ts`; integration `vitest.integration.config.ts` needs `docker compose up -d db`), pg-boss.

## Global Constraints

- **Node ≥ 20**, ESM, `@/` alias. Money = integer **minor units**.
- **Reserve/settle/release MUST run inside `db.transaction(...)`** (their doc comments say so) — the balance UPDATE and the ledger INSERT must commit atomically.
- **Reserve-before-spend ordering is sacred:** never call `provider.complete` on a paused/halted run or when the reservation failed. This is the load-bearing safety property from Slice 1 — preserve it exactly.
- Services take `actingUserId` first / `db` last, own their transaction, do their own authz, and write `outbox` in the same tx. Internal tx-helpers (`reserveStep`, `releaseReservation`, `createRunFromPledge`) take an executor first.
- Cross-tenant → `NotFoundError`; wrong-role → `ForbiddenError`; bad state → `InvalidStateError`.
- **Merit integrity:** nothing here may reference or import Scoring/Engagement/Discovery. `scoring-boundary.test.ts` already guards this — do not regress it.
- Integration tests run against a real Postgres: prefix with `TEST_DATABASE_URL=postgres://hodorhub:hodorhub@localhost:5432/hodorhub_test DATABASE_URL=postgres://hodorhub:hodorhub@localhost:5432/hodorhub_test`.

## Current state (merged foundation — do not re-create)

- `src/modules/agent-delivery/orchestrator.ts` — `runRequirementsPhase(runId, provider, db)`: guards paused/halted, reserves (halts on `BudgetExceededError` before the model call), calls the planner, settles, writes an `agent_steps` row, upserts the `requirements` milestone to `awaiting_review`, sets run `awaiting_gate`. Re-exports the gate functions.
- `src/modules/agent-delivery/service.ts` — `createRunFromPledge`, `approveMilestone` (advances `currentPhase` to the next `PHASE_ORDER` entry + status `authorized`, or `completed` on the last), `requestChanges` (run → `running`), `rejectMilestone` (run → `failed`), `setRunStatus` (platform-admin kill switch). `PHASE_ORDER = ['requirements','design','build','delivery']`.
- `src/modules/agent-delivery/budget.ts` — `reserveStep`, `settleStep`, `getBalance`. `ledgerEntryType` enum includes `'release'` (currently unused).
- `src/modules/agent-delivery/budget-math.ts` — `estimateMaxCostMinor`, `actualCostMinor`, `priceBook`, `PRICE_BOOK_VERSION`.
- `src/modules/agent-delivery/index.ts` — barrel exporting the above.
- Run status enum: `authorized | running | awaiting_gate | paused | halted | completed | failed`. Phase enum: `requirements | design | build | delivery`.

---

### Task 1: Budget `releaseReservation`

**Files:**
- Modify: `src/modules/agent-delivery/budget.ts`
- Modify: `src/modules/agent-delivery/index.ts` (export it)
- Test: `src/modules/agent-delivery/budget.integration.test.ts` (add a case)

**Interfaces:**
- Produces: `releaseReservation(exec: Executor, runId: string, estimateMinor: number): Promise<void>` — decrements `reservedMinor` by `estimateMinor` and writes a `release` ledger row. Executor-first internal tx-helper.

- [ ] **Step 1: Add the failing test case**

Append this `it` block inside the existing `describe` in `src/modules/agent-delivery/budget.integration.test.ts` (it already imports `reserveStep`, `settleStep`, `getBalance`, and has the `seedRun` helper — add `releaseReservation` to the import from `./budget`):
```ts
  it('releases a reservation back to remaining and records a release ledger entry', async () => {
    const runId = await seedRun(100);
    await reserveStep(testDb, runId, 40);
    await releaseReservation(testDb, runId, 40);
    const b = await getBalance(testDb, runId);
    expect(b.reservedMinor).toBe(0);
    expect(b.consumedMinor).toBe(0);
    expect(b.remainingMinor).toBe(100);
    const ledger = await testDb
      .select()
      .from(runBudgetLedger)
      .where(eq(runBudgetLedger.runId, runId));
    expect(ledger.some((e) => e.entryType === 'release' && e.amountMinor === 40)).toBe(true);
  });
```
Add `runBudgetLedger` to the `@/db/schema` import at the top of the test file if not already present.

- [ ] **Step 2: Run it to verify it fails**

Run: `TEST_DATABASE_URL=postgres://hodorhub:hodorhub@localhost:5432/hodorhub_test DATABASE_URL=postgres://hodorhub:hodorhub@localhost:5432/hodorhub_test npm run test:integration -- src/modules/agent-delivery/budget.integration.test.ts`
Expected: FAIL — `releaseReservation is not a function` / not exported.

- [ ] **Step 3: Implement `releaseReservation`**

Add to `src/modules/agent-delivery/budget.ts` (after `settleStep`):
```ts
/**
 * Release a previously-reserved amount back to remaining without consuming it —
 * used when a step fails/aborts after reserving but before settling, so a thrown
 * model call never strands budget (US-11.4). Callers MUST invoke inside
 * db.transaction(...) (balance UPDATE + ledger INSERT must be atomic).
 */
export async function releaseReservation(
  exec: Executor,
  runId: string,
  estimateMinor: number,
): Promise<void> {
  await exec
    .update(runBudgets)
    .set({
      reservedMinor: sql`${runBudgets.reservedMinor} - ${estimateMinor}`,
      updatedAt: new Date(),
    })
    .where(eq(runBudgets.runId, runId));
  await exec
    .insert(runBudgetLedger)
    .values({ runId, entryType: 'release', amountMinor: estimateMinor });
}
```
Add `releaseReservation` to the export list in `src/modules/agent-delivery/index.ts`:
```ts
export { reserveStep, settleStep, releaseReservation, getBalance } from './budget';
```

- [ ] **Step 4: Run to verify it passes**

Run: `TEST_DATABASE_URL=postgres://hodorhub:hodorhub@localhost:5432/hodorhub_test DATABASE_URL=postgres://hodorhub:hodorhub@localhost:5432/hodorhub_test npm run test:integration -- src/modules/agent-delivery/budget.integration.test.ts`
Expected: PASS (3 tests).

- [ ] **Step 5: Commit**

```bash
git add src/modules/agent-delivery/budget.ts src/modules/agent-delivery/index.ts src/modules/agent-delivery/budget.integration.test.ts
git commit -m "feat(agent-delivery): releaseReservation for failed/aborted steps"
```

---

### Task 2: Generalize the phase runner — phase guard, Design phase, release-on-failure

**Files:**
- Modify: `src/modules/agent-delivery/orchestrator.ts`
- Modify: `src/modules/agent-delivery/index.ts` (export `runCurrentPhase`)
- Test: `src/modules/agent-delivery/orchestrator.integration.test.ts` (add cases)

**Interfaces:**
- Consumes: `releaseReservation` from `./budget` (Task 1); `InvalidStateError` from `@/modules/identity`.
- Produces: `runCurrentPhase(runId: string, provider: ModelProvider, db?): Promise<{ milestoneId: string; status: 'awaiting_review' | 'halted' | 'skipped' }>`. `runRequirementsPhase` is kept as a thin backward-compatible wrapper (existing tests/imports depend on it).
- Behaviour: runs `run.currentPhase` when it is a runnable phase (`requirements` or `design`); `build`/`delivery` return `'skipped'` (deferred to a later slice). Throws `InvalidStateError` if the current phase's milestone is already `approved` (no re-running an approved phase — the Slice-1 finding). `design` reads the approved `requirements` milestone's `artifactRef` as input. On a thrown `provider.complete`, releases the reservation, writes an `error` step, sets the run `halted`, and returns `'halted'` (never leaves a stranded reservation).

- [ ] **Step 1: Add failing tests**

Add these `it` blocks to `src/modules/agent-delivery/orchestrator.integration.test.ts` (it already has the `authorisedRun` fixture and imports `runRequirementsPhase`, `approveMilestone`, `requestChanges`; add `runCurrentPhase` to the import from `./orchestrator`, and `getBalance` from `./budget` if not present):
```ts
  it('runs the design phase after requirements is approved, reading the requirements artifact', async () => {
    const { charity, runId } = await authorisedRun(20000);
    const provider = new FakeModelProvider([
      { text: 'GIVEN a visitor WHEN they open the site THEN they see the mission' },
      { text: 'ARCHITECTURE: static site + CMS; TASKS: scaffold, content, deploy' },
    ]);
    const r1 = await runCurrentPhase(runId, provider, testDb);
    expect(r1.status).toBe('awaiting_review');
    await approveMilestone(charity.userId, r1.milestoneId, testDb);

    const r2 = await runCurrentPhase(runId, provider, testDb);
    expect(r2.status).toBe('awaiting_review');
    // design phase ran: the design prompt included the approved requirements artifact
    const designCall = provider.calls[1]!;
    expect(designCall.tier).toBe('planner');
    expect(designCall.prompt).toContain('they see the mission');
    const design = await testDb.query.runMilestones.findFirst({
      where: and(eq(runMilestones.runId, runId), eq(runMilestones.phase, 'design')),
    });
    expect(design!.status).toBe('awaiting_review');
  });

  it('refuses to re-run an already-approved phase', async () => {
    const { charity, runId } = await authorisedRun(20000);
    const provider = new FakeModelProvider([{ text: 'criteria' }]);
    const r1 = await runCurrentPhase(runId, provider, testDb);
    await approveMilestone(charity.userId, r1.milestoneId, testDb);
    // run advanced to design; force currentPhase back to requirements to simulate a bad re-invoke
    await testDb
      .update(agentDeliveryRuns)
      .set({ currentPhase: 'requirements', status: 'authorized' })
      .where(eq(agentDeliveryRuns.id, runId));
    await expect(runCurrentPhase(runId, provider, testDb)).rejects.toBeInstanceOf(InvalidStateError);
  });

  it('releases the reservation and halts when the model call throws', async () => {
    const { runId } = await authorisedRun(20000);
    const provider = {
      calls: [] as unknown[],
      async complete() {
        throw new Error('provider exploded');
      },
    } as unknown as FakeModelProvider;
    const r = await runCurrentPhase(runId, provider, testDb);
    expect(r.status).toBe('halted');
    const bal = await getBalance(testDb, runId);
    expect(bal.reservedMinor).toBe(0); // reservation released, not stranded
    expect(bal.consumedMinor).toBe(0);
    const run = await testDb.query.agentDeliveryRuns.findFirst({
      where: eq(agentDeliveryRuns.id, runId),
    });
    expect(run!.status).toBe('halted');
  });

  it('skips a phase not implemented in this slice (build/delivery)', async () => {
    const { runId } = await authorisedRun(20000);
    await testDb
      .update(agentDeliveryRuns)
      .set({ currentPhase: 'build', status: 'authorized' })
      .where(eq(agentDeliveryRuns.id, runId));
    const provider = new FakeModelProvider([{ text: 'x' }]);
    const r = await runCurrentPhase(runId, provider, testDb);
    expect(r.status).toBe('skipped');
    expect(provider.calls).toHaveLength(0);
  });
```
Ensure the test file imports `and` from `drizzle-orm`, `runMilestones`/`agentDeliveryRuns` from `@/db/schema`, and `InvalidStateError` from `@/modules/identity`.

- [ ] **Step 2: Run to verify they fail**

Run: `TEST_DATABASE_URL=postgres://hodorhub:hodorhub@localhost:5432/hodorhub_test DATABASE_URL=postgres://hodorhub:hodorhub@localhost:5432/hodorhub_test npm run test:integration -- src/modules/agent-delivery/orchestrator.integration.test.ts`
Expected: FAIL — `runCurrentPhase` not exported.

- [ ] **Step 3: Rewrite the orchestrator around `runCurrentPhase`**

Replace the body of `src/modules/agent-delivery/orchestrator.ts` with:
```ts
import { and, eq } from 'drizzle-orm';
import { db as defaultDb } from '@/db';
import { agentDeliveryRuns, runMilestones, agentSteps } from '@/db/schema';
import type { ModelProvider, ModelTier } from '@/lib/model-provider';
import { InvalidStateError } from '@/modules/identity';
import { estimateMaxCostMinor, actualCostMinor } from './budget-math';
import { reserveStep, settleStep, releaseReservation } from './budget';
import { BudgetExceededError } from './errors';

export { approveMilestone, requestChanges, rejectMilestone } from './service';

type Db = typeof defaultDb;

type RunnablePhase = 'requirements' | 'design';

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
};

function isRunnablePhase(p: string): p is RunnablePhase {
  return p === 'requirements' || p === 'design';
}

/**
 * Runs whichever phase `run.currentPhase` names, metered by the budget.
 * Deterministic control flow; the model is the only non-deterministic part.
 * - paused/halted run → 'halted' (no work).
 * - build/delivery (not implemented this slice) → 'skipped' (no model call).
 * - an already-approved phase → InvalidStateError (no re-run).
 * - affordability/kill-switch checked BEFORE the model call (US-11.4/11.5).
 * - a thrown model call releases the reservation and halts (no stranded budget).
 */
export async function runCurrentPhase(
  runId: string,
  provider: ModelProvider,
  db: Db = defaultDb,
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

  const spec = PHASE_SPECS[phase];
  const estimate = estimateMaxCostMinor(spec.tier, spec.promptTokens, spec.maxOutput);

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
      await db
        .update(agentDeliveryRuns)
        .set({ status: 'halted', updatedAt: new Date() })
        .where(eq(agentDeliveryRuns.id, runId));
      return { milestoneId: '', status: 'halted' };
    }
    throw e;
  }

  // Design reads the approved requirements artifact as input.
  let priorArtifact: string | null = null;
  if (phase === 'design') {
    const req = await db.query.runMilestones.findFirst({
      where: and(eq(runMilestones.runId, runId), eq(runMilestones.phase, 'requirements')),
    });
    priorArtifact = req?.artifactRef ?? null;
  }
  const { system, prompt } = spec.build(run.templateCode, priorArtifact);

  let response;
  try {
    response = await provider.complete({ tier: spec.tier, system, prompt, maxOutputTokens: spec.maxOutput });
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
      .values({ runId, phase, status: 'awaiting_review', artifactRef: response.text, openedAt: new Date() })
      .onConflictDoUpdate({
        target: [runMilestones.runId, runMilestones.phase],
        set: { status: 'awaiting_review', artifactRef: response.text, openedAt: new Date(), reason: null, decidedAt: null },
      })
      .returning({ id: runMilestones.id });
    await tx
      .update(agentDeliveryRuns)
      .set({ status: 'awaiting_gate', updatedAt: new Date() })
      .where(eq(agentDeliveryRuns.id, runId));
    return { milestoneId: ms!.id, status: 'awaiting_review' as const };
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
```
Add `runCurrentPhase` to `src/modules/agent-delivery/index.ts`:
```ts
export { runRequirementsPhase, runCurrentPhase } from './orchestrator';
```

- [ ] **Step 4: Run the orchestrator + the Slice-1 merit-integrity tests**

Run both (the merit-integrity test uses `runRequirementsPhase`, so confirm the wrapper still works):
```
TEST_DATABASE_URL=postgres://hodorhub:hodorhub@localhost:5432/hodorhub_test DATABASE_URL=postgres://hodorhub:hodorhub@localhost:5432/hodorhub_test npm run test:integration -- src/modules/agent-delivery/orchestrator.integration.test.ts src/modules/agent-delivery/merit-integrity.integration.test.ts
```
Expected: all PASS (the 3 original orchestrator tests + 4 new + the 2 merit-integrity tests).

- [ ] **Step 5: Typecheck + commit**

```bash
npm run typecheck
git add src/modules/agent-delivery/orchestrator.ts src/modules/agent-delivery/index.ts src/modules/agent-delivery/orchestrator.integration.test.ts
git commit -m "feat(agent-delivery): phase-driven runner + design phase + release-on-failure"
```

---

### Task 3: `advanceRun` dispatcher + auto-progression

**Files:**
- Create: `src/modules/agent-delivery/dispatcher.ts`
- Modify: `src/modules/agent-delivery/index.ts` (export `advanceRun`)
- Test: `src/modules/agent-delivery/dispatcher.integration.test.ts`

**Interfaces:**
- Consumes: `runCurrentPhase` from `./orchestrator`; `NotFoundError` from `@/modules/identity`.
- Produces: `advanceRun(runId: string, provider: ModelProvider, db?): Promise<{ ran: boolean; status: string; phase: string }>`. Runs the current phase only when the run is in a runnable state (`authorized` = initial or post-approval; `running` = post changes-requested) AND the current phase is runnable (`requirements`/`design`); otherwise no-ops (returns `ran: false`), so it is safe to call on a run awaiting a human gate, completed, failed, halted, paused, or sitting on a not-yet-implemented phase.

- [ ] **Step 1: Write the failing test**

`src/modules/agent-delivery/dispatcher.integration.test.ts`:
```ts
import { describe, it, expect } from 'vitest';
import { eq } from 'drizzle-orm';
import { testDb } from '@/test/db';
import { agentDeliveryRuns } from '@/db/schema';
import { FakeModelProvider } from '@/lib/fake-model-provider';
import { fundComputeBudget, acceptComputePledge } from '@/modules/commitments';
import {
  registerCharity,
  registerCorporation,
  approveVerification,
  createPlatformAdmin,
} from '@/modules/identity';
import { createDraftProject, setResourceNeeds, publishProject } from '@/modules/projects';
import { advanceRun } from './dispatcher';
import { approveMilestone, requestChanges } from './orchestrator';

async function authorisedRun(budgetMinor: number) {
  const admin = await createPlatformAdmin('admin@hh.com', 'admin-password-1', testDb);
  const charity = await registerCharity({ email: 'petra@goodcause.org', password: 'a-strong-password', charityName: 'Good Cause', regNumber: 'CH-1' }, testDb);
  const corp = await registerCorporation({ email: 'carlos@acme.com', password: 'a-strong-password', companyName: 'Acme', emailDomain: 'acme.com' }, testDb);
  await approveVerification(charity.verificationRequestId, admin, testDb);
  await approveVerification(corp.verificationRequestId, admin, testDb);
  const project = await createDraftProject(charity.userId, { charityOrgId: charity.organisationId, title: 'Portal', description: 'A worthy cause that needs a hand.', goal: 'Reach the finish line.', category: 'software' }, testDb);
  await setResourceNeeds(charity.userId, project.projectId, [{ skill: 'Backend', role: 'Dev', kind: 'ongoing', quantity: 1, hoursPerWeek: 2, durationWeeks: 8 }], testDb);
  await publishProject(charity.userId, project.projectId, testDb);
  const { computePledgeId } = await fundComputeBudget(corp.userId, project.projectId, { corporationOrgId: corp.organisationId, templateCode: 'static-site', budgetMinor }, testDb);
  const { runId } = await acceptComputePledge(charity.userId, computePledgeId, testDb);
  return { charity, runId };
}

describe('agent-delivery dispatcher (advanceRun)', () => {
  it('drives requirements → gate → design → gate across approvals', async () => {
    const { charity, runId } = await authorisedRun(20000);
    const provider = new FakeModelProvider([{ text: 'criteria' }, { text: 'design doc' }]);

    const a1 = await advanceRun(runId, provider, testDb);
    expect(a1.ran).toBe(true);
    let run = await testDb.query.agentDeliveryRuns.findFirst({ where: eq(agentDeliveryRuns.id, runId) });
    expect(run!.status).toBe('awaiting_gate');
    expect(run!.currentPhase).toBe('requirements');

    // human approves requirements → run authorized on design
    const reqMs = await testDb.query.runMilestones.findFirst({ where: eq(agentDeliveryRuns.id, runId) }).catch(() => null);
    // approve via the milestone id from the run's requirements milestone
    const { runMilestones } = await import('@/db/schema');
    const reqMilestone = await testDb.query.runMilestones.findFirst({ where: eq(runMilestones.runId, runId) });
    await approveMilestone(charity.userId, reqMilestone!.id, testDb);

    const a2 = await advanceRun(runId, provider, testDb);
    expect(a2.ran).toBe(true);
    run = await testDb.query.agentDeliveryRuns.findFirst({ where: eq(agentDeliveryRuns.id, runId) });
    expect(run!.status).toBe('awaiting_gate');
    expect(run!.currentPhase).toBe('design');
    expect(provider.calls).toHaveLength(2);
  });

  it('no-ops on a run awaiting a human gate', async () => {
    const { runId } = await authorisedRun(20000);
    const provider = new FakeModelProvider([{ text: 'criteria' }, { text: 'second' }]);
    await advanceRun(runId, provider, testDb); // runs requirements → awaiting_gate
    const a = await advanceRun(runId, provider, testDb); // must NOT run again while awaiting gate
    expect(a.ran).toBe(false);
    expect(provider.calls).toHaveLength(1);
  });

  it('re-runs the current phase after changes are requested', async () => {
    const { charity, runId } = await authorisedRun(20000);
    const provider = new FakeModelProvider([{ text: 'draft one' }, { text: 'draft two' }]);
    await advanceRun(runId, provider, testDb);
    const { runMilestones } = await import('@/db/schema');
    const ms = await testDb.query.runMilestones.findFirst({ where: eq(runMilestones.runId, runId) });
    await requestChanges(charity.userId, ms!.id, 'Add an accessibility criterion', testDb);
    const a = await advanceRun(runId, provider, testDb); // run is 'running' → re-run requirements
    expect(a.ran).toBe(true);
    expect(provider.calls).toHaveLength(2);
    const run = await testDb.query.agentDeliveryRuns.findFirst({ where: eq(agentDeliveryRuns.id, runId) });
    expect(run!.status).toBe('awaiting_gate');
  });
});
```

- [ ] **Step 2: Run to verify it fails**

Run: `TEST_DATABASE_URL=postgres://hodorhub:hodorhub@localhost:5432/hodorhub_test DATABASE_URL=postgres://hodorhub:hodorhub@localhost:5432/hodorhub_test npm run test:integration -- src/modules/agent-delivery/dispatcher.integration.test.ts`
Expected: FAIL — cannot find module `./dispatcher`.

- [ ] **Step 3: Implement the dispatcher**

`src/modules/agent-delivery/dispatcher.ts`:
```ts
import { eq } from 'drizzle-orm';
import { db as defaultDb } from '@/db';
import { agentDeliveryRuns } from '@/db/schema';
import type { ModelProvider } from '@/lib/model-provider';
import { NotFoundError } from '@/modules/identity';
import { runCurrentPhase } from './orchestrator';

type Db = typeof defaultDb;

/**
 * Dispatcher: advance a run by running its current phase when it is in a
 * runnable state. A run is runnable when `authorized` (freshly authorised, or
 * a prior phase just approved → next phase) or `running` (a gate returned
 * changes-requested → re-run the current phase). Any other status
 * (awaiting_gate, completed, failed, halted, paused) is a no-op, so this is
 * safe to call speculatively — e.g. from a worker reacting to a gate event.
 *
 * This is the logic a future pg-boss worker will call with a real provider
 * (Slice 3); here it is a plain, offline-testable service function.
 */
export async function advanceRun(
  runId: string,
  provider: ModelProvider,
  db: Db = defaultDb,
): Promise<{ ran: boolean; status: string; phase: string }> {
  const run = await db.query.agentDeliveryRuns.findFirst({
    where: eq(agentDeliveryRuns.id, runId),
  });
  if (!run) throw new NotFoundError('Run');

  const runnableStatus = run.status === 'authorized' || run.status === 'running';
  if (!runnableStatus) {
    return { ran: false, status: run.status, phase: run.currentPhase };
  }

  const result = await runCurrentPhase(runId, provider, db);
  const after = await db.query.agentDeliveryRuns.findFirst({
    where: eq(agentDeliveryRuns.id, runId),
  });
  return {
    ran: result.status !== 'skipped',
    status: after!.status,
    phase: after!.currentPhase,
  };
}
```
Add to `src/modules/agent-delivery/index.ts`:
```ts
export { advanceRun } from './dispatcher';
```

- [ ] **Step 4: Run to verify it passes**

Run: `TEST_DATABASE_URL=postgres://hodorhub:hodorhub@localhost:5432/hodorhub_test DATABASE_URL=postgres://hodorhub:hodorhub@localhost:5432/hodorhub_test npm run test:integration -- src/modules/agent-delivery/dispatcher.integration.test.ts`
Expected: PASS (3 tests).

- [ ] **Step 5: Full gate + commit**

```bash
npm run typecheck && npm test && TEST_DATABASE_URL=postgres://hodorhub:hodorhub@localhost:5432/hodorhub_test DATABASE_URL=postgres://hodorhub:hodorhub@localhost:5432/hodorhub_test npm run test:integration
```
Expected: all green.
```bash
git add src/modules/agent-delivery/dispatcher.ts src/modules/agent-delivery/index.ts src/modules/agent-delivery/dispatcher.integration.test.ts
git commit -m "feat(agent-delivery): advanceRun dispatcher (auto-progress through gated phases)"
```

---

## What this slice delivers

A run now progresses automatically: `advanceRun` runs requirements → the charity gates it → `advanceRun` runs design (reading the approved requirements) → the charity gates it; changes-requested loops the phase; a failed model call releases its reservation instead of stranding budget; and no phase is ever double-run. All offline against the fake provider.

## Explicitly out of scope (Slice 3)

The pg-boss worker + outbox-relay wiring that calls `advanceRun` automatically in production (needs the real provider it constructs), the real provider adapter, the microVM sandbox, the Build/Delivery phases, and the Deployer + staging URL. Build/delivery phases return `'skipped'` today.

## Self-review notes

- **Coverage:** dispatcher (Task 3), release path + release-on-failure (Tasks 1–2), design phase + phase guard (Task 2). All named follow-ups except the infra-gated ones.
- **No regression:** `runRequirementsPhase` kept as a wrapper so Slice-1 tests (orchestrator + merit-integrity) still pass; Step 4 of Task 2 runs them.
- **Safety preserved:** reserve-before-model ordering unchanged; the new failure path only *releases* (never consumes), so the money ceiling is never weakened.
- **Type consistency:** `runCurrentPhase` return union (`awaiting_review|halted|skipped`) is handled by both `advanceRun` and the `runRequirementsPhase` wrapper.
