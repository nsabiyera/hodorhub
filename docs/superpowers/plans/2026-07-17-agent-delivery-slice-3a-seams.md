# Agent-Delivery Slice 3a — Build/Delivery phases on fakes, seams & worker wiring

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make a full agent-delivery run flow end-to-end — requirements → design → **build** → **delivery (staging URL)** — entirely on fakes, plus the worker wiring that drives it, so the pipeline is complete and offline-verifiable before real infrastructure (Slice 3b) is wired.

**Architecture:** Add `deployed_environments`; add two tool-contract seams mirroring `ModelProvider` — `SandboxRunner` (code exec) and `DeployerClient` (deploy) — each with a `Fake*` impl. Extend the orchestrator so the **Build** phase runs a worker-tier model step + a sandbox build, and add a non-model **Delivery** phase that deploys to a staging URL and records it. Emit a terminal `RunClosed` event. Wire `advanceRun` to the pg-boss worker (relay subscriber enqueue + `agent.advance` handler + a reconciliation sweep). Real provider/sandbox/deployer implementations are Slice 3b; here everything runs on fakes.

**Tech Stack:** TypeScript (ESM, `@/` alias), Drizzle/Postgres, drizzle-kit, pg-boss, Vitest (unit `vitest.config.ts`; integration `vitest.integration.config.ts` needs `docker compose up -d db`).

## Global Constraints

- **Node ≥ 20**, ESM, `@/` alias. Money = integer **minor units**.
- **Reserve-before-spend ordering is sacred** and already correct: never call a paid model step on a paused/halted run or when the reservation failed; the final status transition is a compare-and-set (`running → awaiting_gate`) so a mid-phase kill wins. Preserve this in every new phase.
- Reserve/settle/release run inside `db.transaction(...)`. Services take `actingUserId` first / `db` last; internal tx-helpers take an executor first. Outbox events are written in the same tx as their state change.
- Cross-tenant → `NotFoundError`; wrong-role → `ForbiddenError`; bad state → `InvalidStateError`.
- **Merit integrity:** nothing here may reference/import Scoring/Engagement/Discovery, and `deployed_environments` must be added to the `scoring-boundary.test.ts` forbidden list.
- **Fakes only:** no real model/sandbox/deploy. `SandboxRunner`/`DeployerClient` are injected; the worker's real construction of them is Slice 3b (a factory that throws for non-fake until then).
- Integration tests: prefix with `TEST_DATABASE_URL=postgres://hodorhub:hodorhub@localhost:5432/hodorhub_test DATABASE_URL=postgres://hodorhub:hodorhub@localhost:5432/hodorhub_test`.

## Current state (merged; do not re-create)

- `orchestrator.ts`: `runCurrentPhase(runId, provider, db)` runs `requirements`/`design` (planner tier), guards paused/halted, reserves→model→settle, opens the phase milestone `awaiting_review`, CAS-transitions run→`awaiting_gate` (kill-safe); `build`/`delivery` currently return `'skipped'`. `PHASE_SPECS` maps `requirements`/`design`. `runRequirementsPhase` is a back-compat wrapper.
- `service.ts`: `approveMilestone` (advances `PHASE_ORDER = [requirements,design,build,delivery]`; on the last phase sets run `completed`), `requestChanges` (→`running`), `rejectMilestone` (→`failed`), `setRunStatus` (platform-admin kill switch, →`paused`/`running`/`halted`), `createRunFromPledge`. Emits `MilestoneApproved`/`MilestoneChangesRequested`/`MilestoneRejected`/`RunStatusChanged` to the outbox.
- `dispatcher.ts`: `advanceRun(runId, provider, db)` runs the current phase when run status is `authorized`/`running`, else no-ops.
- `budget.ts`: `reserveStep`/`settleStep`/`releaseReservation`/`getBalance`. `budget-math.ts`: `estimateMaxCostMinor`/`actualCostMinor`/`priceBook` (tiers `planner`/`worker`/`reviewer`).
- `src/lib/model-provider.ts` (interface) + `fake-model-provider.ts`. `relay.ts` (`relayOutbox` → Notifications `dispatchEvent` only). `src/worker/index.ts` (pg-boss queues + outbox relay `setInterval`).
- Run status enum: `authorized|running|awaiting_gate|paused|halted|completed|failed`. Phase enum: `requirements|design|build|delivery`.

---

### Task 1: `deployed_environments` table + migration + boundary guard

**Files:**
- Modify: `src/db/schema.ts` (enums near the agent-delivery enums; table after `agentSteps`)
- Modify: `src/modules/scoring-boundary.test.ts` (add to forbidden token regex)
- Create (generated): `drizzle/NNNN_*.sql` via `npm run db:generate`

**Interfaces:**
- Produces: `deployedEnvironments` table + enums `deployedEnvironment` (`staging|production`) and `deployedEnvStatus` (`deploying|live|failed|torn_down`), importable from `@/db/schema`.

- [ ] **Step 1: Add enums + table**

In `src/db/schema.ts`, after the existing agent-delivery enums add:
```ts
export const deployedEnvironment = pgEnum('deployed_environment', ['staging', 'production']);
export const deployedEnvStatus = pgEnum('deployed_env_status', ['deploying', 'live', 'failed', 'torn_down']);
```
After the `agentSteps` table add:
```ts
// Delivered-app environments (Epic 11 / Slice 3). Sole writer is the Deployer.
// Read by the charity UI. Never referenced by Scoring/Discovery (US-11.9).
export const deployedEnvironments = pgTable('deployed_environments', {
  id: uuid('id').primaryKey().defaultRandom(),
  runId: uuid('run_id').notNull().references(() => agentDeliveryRuns.id),
  environment: deployedEnvironment('environment').notNull(),
  url: text('url'),
  revisionRef: text('revision_ref'),
  status: deployedEnvStatus('status').notNull().default('deploying'),
  deployedAt: timestamp('deployed_at', { withTimezone: true }),
  tornDownAt: timestamp('torn_down_at', { withTimezone: true }),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
});
```

- [ ] **Step 2: Extend the merit-integrity guard**

In `src/modules/scoring-boundary.test.ts`, add `deployed_environments|deployedEnvironments` to the forbidden-token regex used by the "never references agent-delivery run tables" test.

- [ ] **Step 3: Generate migration + typecheck**

Run: `npm run db:generate` — confirm a new `drizzle/NNNN_*.sql` with `CREATE TABLE "deployed_environments"` and the two `CREATE TYPE`s. Then `npm run typecheck` (clean) and `npm test -- src/modules/scoring-boundary.test.ts` (still passes — nothing references the new table yet).

- [ ] **Step 4: Commit**

```bash
git add src/db/schema.ts src/modules/scoring-boundary.test.ts drizzle/
git commit -m "feat(agent-delivery): deployed_environments table + merit-integrity guard"
```

---

### Task 2: Sandbox & Deployer seams (interfaces + fakes)

**Files:**
- Create: `src/lib/sandbox-runner.ts`, `src/lib/fake-sandbox-runner.ts`
- Create: `src/lib/deployer.ts`, `src/lib/fake-deployer.ts`
- Test: `src/lib/fake-sandbox-runner.test.ts`, `src/lib/fake-deployer.test.ts`

**Interfaces:**
- Produces: `SandboxBuildRequest = { templateCode: string; designArtifact: string | null; code: string }`; `SandboxBuildResult = { testsPassed: boolean; log: string; artifactRef: string }`; `interface SandboxRunner { runBuild(req: SandboxBuildRequest): Promise<SandboxBuildResult> }`; `class FakeSandboxRunner implements SandboxRunner` (ctor `(result?: Partial<SandboxBuildResult>)`, records `calls`). And `DeployRequest = { runId: string; environment: 'staging' | 'production'; artifactRef: string }`; `DeployResult = { url: string; revisionRef: string }`; `interface DeployerClient { deploy(req: DeployRequest): Promise<DeployResult> }`; `class FakeDeployer implements DeployerClient` (ctor `(result?: Partial<DeployResult>)`, records `calls`).

- [ ] **Step 1: Write the interfaces**

`src/lib/sandbox-runner.ts`:
```ts
/**
 * Tool-contract seam for running agent-generated code in an isolated sandbox
 * (Epic 11). Mirrors the ModelProvider pattern: orchestration depends only on
 * this interface; a microVM-backed implementation lands in Slice 3b. The
 * sandbox holds no HodorHub credentials and has restricted egress.
 */
export interface SandboxBuildRequest {
  templateCode: string;
  designArtifact: string | null;
  code: string;
}
export interface SandboxBuildResult {
  testsPassed: boolean;
  log: string;
  artifactRef: string;
}
export interface SandboxRunner {
  runBuild(req: SandboxBuildRequest): Promise<SandboxBuildResult>;
}
```

`src/lib/deployer.ts`:
```ts
/**
 * Tool-contract seam for the privileged Deployer (Epic 11) — deploys a built
 * artifact to a staging/production URL. Runs OUTSIDE every agent's toolset
 * under its own identity; a real Cloud Run deployer lands in Slice 3b.
 */
export interface DeployRequest {
  runId: string;
  environment: 'staging' | 'production';
  artifactRef: string;
}
export interface DeployResult {
  url: string;
  revisionRef: string;
}
export interface DeployerClient {
  deploy(req: DeployRequest): Promise<DeployResult>;
}
```

- [ ] **Step 2: Write failing tests**

`src/lib/fake-sandbox-runner.test.ts`:
```ts
import { describe, it, expect } from 'vitest';
import { FakeSandboxRunner } from './fake-sandbox-runner';

describe('FakeSandboxRunner', () => {
  it('returns a passing build by default and records the request', async () => {
    const s = new FakeSandboxRunner();
    const r = await s.runBuild({ templateCode: 'static-site', designArtifact: 'd', code: 'c' });
    expect(r.testsPassed).toBe(true);
    expect(r.artifactRef).toBeTruthy();
    expect(s.calls).toHaveLength(1);
    expect(s.calls[0]!.templateCode).toBe('static-site');
  });

  it('honors an overridden result (e.g. failing tests)', async () => {
    const s = new FakeSandboxRunner({ testsPassed: false, log: 'boom' });
    const r = await s.runBuild({ templateCode: 't', designArtifact: null, code: 'c' });
    expect(r.testsPassed).toBe(false);
    expect(r.log).toBe('boom');
  });
});
```

`src/lib/fake-deployer.test.ts`:
```ts
import { describe, it, expect } from 'vitest';
import { FakeDeployer } from './fake-deployer';

describe('FakeDeployer', () => {
  it('returns a staging URL and records the request', async () => {
    const d = new FakeDeployer();
    const r = await d.deploy({ runId: 'run-1', environment: 'staging', artifactRef: 'a' });
    expect(r.url).toContain('run-1');
    expect(r.revisionRef).toBeTruthy();
    expect(d.calls[0]!.environment).toBe('staging');
  });
});
```

- [ ] **Step 3: Run — verify they fail** (`npm test -- src/lib/fake-sandbox-runner.test.ts src/lib/fake-deployer.test.ts`; FAIL, modules missing).

- [ ] **Step 4: Implement the fakes**

`src/lib/fake-sandbox-runner.ts`:
```ts
import type { SandboxRunner, SandboxBuildRequest, SandboxBuildResult } from './sandbox-runner';

/** Deterministic, offline SandboxRunner for tests — no real code execution. */
export class FakeSandboxRunner implements SandboxRunner {
  public readonly calls: SandboxBuildRequest[] = [];
  constructor(private readonly result: Partial<SandboxBuildResult> = {}) {}
  async runBuild(req: SandboxBuildRequest): Promise<SandboxBuildResult> {
    this.calls.push(req);
    return {
      testsPassed: this.result.testsPassed ?? true,
      log: this.result.log ?? 'fake build: 3 passed, 0 failed',
      artifactRef: this.result.artifactRef ?? `fake-artifact:${req.templateCode}`,
    };
  }
}
```

`src/lib/fake-deployer.ts`:
```ts
import type { DeployerClient, DeployRequest, DeployResult } from './deployer';

/** Deterministic, offline DeployerClient for tests — no real deploy. */
export class FakeDeployer implements DeployerClient {
  public readonly calls: DeployRequest[] = [];
  constructor(private readonly result: Partial<DeployResult> = {}) {}
  async deploy(req: DeployRequest): Promise<DeployResult> {
    this.calls.push(req);
    return {
      url: this.result.url ?? `https://${req.runId}.preview.hodorhub.app`,
      revisionRef: this.result.revisionRef ?? `rev-${req.runId}`,
    };
  }
}
```

- [ ] **Step 5: Run — verify they pass**, then commit:
```bash
git add src/lib/sandbox-runner.ts src/lib/fake-sandbox-runner.ts src/lib/deployer.ts src/lib/fake-deployer.ts src/lib/fake-sandbox-runner.test.ts src/lib/fake-deployer.test.ts
git commit -m "feat(agent-delivery): SandboxRunner + DeployerClient seams (+ fakes)"
```

---

### Task 3: Build phase (worker model step + sandbox build)

**Files:**
- Modify: `src/modules/agent-delivery/orchestrator.ts`
- Test: `src/modules/agent-delivery/orchestrator.integration.test.ts`

**Interfaces:**
- Consumes: `SandboxRunner` from `@/lib/sandbox-runner`.
- Changes: `runCurrentPhase(runId, provider, db?, deps?: { sandbox?: SandboxRunner })`. Adds `build` to the runnable phases and `PHASE_SPECS` (worker tier). For `build`, after the worker model call it calls `deps.sandbox.runBuild(...)`; if `deps?.sandbox` is missing it throws `InvalidStateError('Build phase requires a sandbox runner.')`. The milestone `artifactRef` records the design-derived code summary + the sandbox test result. Requirements/design behaviour is unchanged (they ignore `deps`).

- [ ] **Step 1: Add failing tests**

Add to `orchestrator.integration.test.ts` (import `FakeSandboxRunner` from `@/lib/fake-sandbox-runner`):
```ts
  it('runs the build phase: worker model step + sandbox build → awaiting_review', async () => {
    const { charity, runId } = await authorisedRun(50000);
    const provider = new FakeModelProvider([{ text: 'criteria' }, { text: 'design' }, { text: 'CODE: index.html + tests' }]);
    const sandbox = new FakeSandboxRunner();
    // advance requirements → approve → design → approve → build
    const r1 = await runCurrentPhase(runId, provider, testDb);
    await approveMilestone(charity.userId, r1.milestoneId, testDb);
    const r2 = await runCurrentPhase(runId, provider, testDb);
    await approveMilestone(charity.userId, r2.milestoneId, testDb);
    const r3 = await runCurrentPhase(runId, provider, testDb, { sandbox });
    expect(r3.status).toBe('awaiting_review');
    expect(sandbox.calls).toHaveLength(1);
    const ms = await testDb.query.runMilestones.findFirst({
      where: and(eq(runMilestones.runId, runId), eq(runMilestones.phase, 'build')),
    });
    expect(ms!.status).toBe('awaiting_review');
    const step = await testDb.select().from(agentSteps).where(and(eq(agentSteps.runId, runId), eq(agentSteps.phase, 'build')));
    expect(step[0]!.role).toBe('worker');
  });

  it('build phase throws if no sandbox runner is provided', async () => {
    const { charity, runId } = await authorisedRun(50000);
    const provider = new FakeModelProvider([{ text: 'criteria' }, { text: 'design' }, { text: 'code' }]);
    const r1 = await runCurrentPhase(runId, provider, testDb);
    await approveMilestone(charity.userId, r1.milestoneId, testDb);
    const r2 = await runCurrentPhase(runId, provider, testDb);
    await approveMilestone(charity.userId, r2.milestoneId, testDb);
    await expect(runCurrentPhase(runId, provider, testDb)).rejects.toBeInstanceOf(InvalidStateError);
  });
```

- [ ] **Step 2: Run — verify they fail** (build currently returns `'skipped'`, so the first test's `awaiting_review` assertion fails; the second doesn't throw).

- [ ] **Step 3: Implement the build phase**

In `orchestrator.ts`: import `SandboxRunner` type. Extend the runnable-phase type and `PHASE_SPECS`:
```ts
import type { SandboxRunner } from '@/lib/sandbox-runner';

type RunnablePhase = 'requirements' | 'design' | 'build';

// add to PHASE_SPECS:
  build: {
    tier: 'worker',
    maxOutput: 8000,
    promptTokens: 4000,
    build: (templateCode, priorArtifact) => ({
      system: 'You are the build worker. Implement the design as code with tests.',
      prompt: `Implement template ${templateCode} to satisfy this approved design:\n${priorArtifact ?? '(none)'}`,
    }),
  },
```
Update `isRunnablePhase` to include `'build'`. Change the signature to `runCurrentPhase(runId, provider, db = defaultDb, deps: { sandbox?: SandboxRunner } = {})`. For `design` the prior artifact is the approved `requirements` milestone; for `build` it is the approved `design` milestone — generalize the prior-artifact lookup:
```ts
const PRIOR_PHASE: Partial<Record<RunnablePhase, 'requirements' | 'design'>> = { design: 'requirements', build: 'design' };
...
let priorArtifact: string | null = null;
const priorPhase = PRIOR_PHASE[phase];
if (priorPhase) {
  const prev = await db.query.runMilestones.findFirst({
    where: and(eq(runMilestones.runId, runId), eq(runMilestones.phase, priorPhase)),
  });
  priorArtifact = prev?.artifactRef ?? null;
}
```
After the successful model call, for the build phase run the sandbox and fold the result into the artifact text:
```ts
let artifactText = response.text;
if (phase === 'build') {
  if (!deps.sandbox) throw new InvalidStateError('Build phase requires a sandbox runner.');
  const built = await deps.sandbox.runBuild({ templateCode: run.templateCode, designArtifact: priorArtifact, code: response.text });
  artifactText = `${built.artifactRef}\ntests: ${built.testsPassed ? 'passed' : 'FAILED'}\n${built.log}`;
}
```
Then use `artifactText` (instead of `response.text`) as the milestone `artifactRef` in the settle tx. Everything else (reserve, settle, agentSteps with `role: spec.tier`, CAS status transition) is unchanged.

> Note: the sandbox `InvalidStateError` is thrown AFTER the model call has settled — the reservation is already reconciled, so no budget is stranded; the run is left `running` and the throw propagates (a missing sandbox is a programming error, not a run-time halt). This is acceptable because the worker always injects a sandbox in production; the test asserts the throw.

- [ ] **Step 4: Run — verify pass**, typecheck, commit:
```bash
npm run typecheck
git add src/modules/agent-delivery/orchestrator.ts src/modules/agent-delivery/orchestrator.integration.test.ts
git commit -m "feat(agent-delivery): build phase (worker model step + sandbox build)"
```

---

### Task 4: Delivery phase (deploy to staging) + advanceRun routing

**Files:**
- Create: `src/modules/agent-delivery/delivery.ts`
- Modify: `src/modules/agent-delivery/dispatcher.ts` (route delivery), `src/modules/agent-delivery/index.ts`
- Test: `src/modules/agent-delivery/delivery.integration.test.ts`

**Interfaces:**
- Consumes: `DeployerClient` from `@/lib/deployer`; `deployedEnvironments`, `runMilestones`, `agentDeliveryRuns` from `@/db/schema`.
- Produces: `runDeliveryPhase(runId: string, deployer: DeployerClient, db?): Promise<{ milestoneId: string; status: 'awaiting_review' | 'halted' }>` — deploys the approved build artifact to a **staging** URL, inserts a `deployed_environments` row (`environment: 'staging'`, `status: 'live'`), opens the `delivery` milestone `awaiting_review`, and CAS-transitions the run `running → awaiting_gate` (kill-safe). No model call, no budget reservation (deploy has no token cost). Changes `advanceRun(runId, provider, db?, deps?: { sandbox?: SandboxRunner; deployer?: DeployerClient })` to route `currentPhase === 'delivery'` to `runDeliveryPhase` (requires `deps.deployer`) and everything else to `runCurrentPhase`.

- [ ] **Step 1: Write the failing test**

`src/modules/agent-delivery/delivery.integration.test.ts` — build the run up to the delivery phase (reuse the `authorisedRun` fixture pattern from the orchestrator test), approve build, then:
```ts
import { describe, it, expect } from 'vitest';
import { and, eq } from 'drizzle-orm';
import { testDb } from '@/test/db';
import { agentDeliveryRuns, runMilestones, deployedEnvironments } from '@/db/schema';
import { FakeModelProvider } from '@/lib/fake-model-provider';
import { FakeSandboxRunner } from '@/lib/fake-sandbox-runner';
import { FakeDeployer } from '@/lib/fake-deployer';
import { fundComputeBudget, acceptComputePledge } from '@/modules/commitments';
import { registerCharity, registerCorporation, approveVerification, createPlatformAdmin } from '@/modules/identity';
import { createDraftProject, setResourceNeeds, publishProject } from '@/modules/projects';
import { runCurrentPhase, approveMilestone } from './orchestrator';
import { runDeliveryPhase } from './delivery';

async function runToDelivery() {
  const admin = await createPlatformAdmin('admin@hh.com', 'admin-password-1', testDb);
  const charity = await registerCharity({ email: 'petra@goodcause.org', password: 'a-strong-password', charityName: 'Good Cause', regNumber: 'CH-1' }, testDb);
  const corp = await registerCorporation({ email: 'carlos@acme.com', password: 'a-strong-password', companyName: 'Acme', emailDomain: 'acme.test' }, testDb);
  await approveVerification(charity.verificationRequestId, admin, testDb);
  await approveVerification(corp.verificationRequestId, admin, testDb);
  const project = await createDraftProject(charity.userId, { charityOrgId: charity.organisationId, title: 'Portal', description: 'A worthy cause that needs a hand.', goal: 'Reach the finish line.', category: 'software' }, testDb);
  await setResourceNeeds(charity.userId, project.projectId, [{ skill: 'Backend', role: 'Dev', kind: 'ongoing', quantity: 1, hoursPerWeek: 2, durationWeeks: 8 }], testDb);
  await publishProject(charity.userId, project.projectId, testDb);
  const { computePledgeId } = await fundComputeBudget(corp.userId, project.projectId, { corporationOrgId: corp.organisationId, templateCode: 'static-site', budgetMinor: 50000 }, testDb);
  const { runId } = await acceptComputePledge(charity.userId, computePledgeId, testDb);
  const provider = new FakeModelProvider([{ text: 'criteria' }, { text: 'design' }, { text: 'code' }]);
  const sandbox = new FakeSandboxRunner();
  const a = await runCurrentPhase(runId, provider, testDb); await approveMilestone(charity.userId, a.milestoneId, testDb);
  const b = await runCurrentPhase(runId, provider, testDb); await approveMilestone(charity.userId, b.milestoneId, testDb);
  const c = await runCurrentPhase(runId, provider, testDb, { sandbox }); await approveMilestone(charity.userId, c.milestoneId, testDb);
  return { charity, runId };
}

describe('agent-delivery delivery phase', () => {
  it('deploys to a staging URL, records it, and opens the delivery gate', async () => {
    const { runId } = await runToDelivery();
    const deployer = new FakeDeployer();
    const r = await runDeliveryPhase(runId, deployer, testDb);
    expect(r.status).toBe('awaiting_review');
    expect(deployer.calls[0]!.environment).toBe('staging');
    const env = await testDb.query.deployedEnvironments.findFirst({ where: eq(deployedEnvironments.runId, runId) });
    expect(env!.environment).toBe('staging');
    expect(env!.status).toBe('live');
    expect(env!.url).toContain(runId);
    const run = await testDb.query.agentDeliveryRuns.findFirst({ where: eq(agentDeliveryRuns.id, runId) });
    expect(run!.status).toBe('awaiting_gate');
    const ms = await testDb.query.runMilestones.findFirst({ where: and(eq(runMilestones.runId, runId), eq(runMilestones.phase, 'delivery')) });
    expect(ms!.status).toBe('awaiting_review');
  });
});
```

- [ ] **Step 2: Run — verify it fails** (module `./delivery` missing).

- [ ] **Step 3: Implement `runDeliveryPhase`**

`src/modules/agent-delivery/delivery.ts`:
```ts
import { and, eq } from 'drizzle-orm';
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
  const run = await db.query.agentDeliveryRuns.findFirst({ where: eq(agentDeliveryRuns.id, runId) });
  if (!run) throw new Error(`No run ${runId}`);
  if (run.status === 'paused' || run.status === 'halted') return { milestoneId: '', status: 'halted' };
  if (run.currentPhase !== 'delivery') throw new InvalidStateError(`Run is not in the delivery phase (${run.currentPhase}).`);

  const build = await db.query.runMilestones.findFirst({
    where: and(eq(runMilestones.runId, runId), eq(runMilestones.phase, 'build')),
  });
  const artifactRef = build?.artifactRef ?? 'unknown-artifact';

  // Deploy happens outside any DB tx (it's an external call, like the model call).
  const deployed = await deployer.deploy({ runId, environment: 'staging', artifactRef });

  return db.transaction(async (tx) => {
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
      .values({ runId, phase: 'delivery', status: 'awaiting_review', artifactRef: deployed.url, openedAt: new Date() })
      .onConflictDoUpdate({
        target: [runMilestones.runId, runMilestones.phase],
        set: { status: 'awaiting_review', artifactRef: deployed.url, openedAt: new Date(), reason: null, decidedAt: null },
      })
      .returning({ id: runMilestones.id });
    // CAS: only running/authorized → awaiting_gate (kill switch wins).
    const advanced = await tx
      .update(agentDeliveryRuns)
      .set({ status: 'awaiting_gate', updatedAt: new Date() })
      .where(and(eq(agentDeliveryRuns.id, runId), inArrayStatus()))
      .returning({ id: agentDeliveryRuns.id });
    return { milestoneId: ms!.id, status: advanced.length === 0 ? ('halted' as const) : ('awaiting_review' as const) };
  });
}
```
Replace `inArrayStatus()` with an inline `sql` predicate `sql\`${agentDeliveryRuns.status} in ('running','authorized')\`` (import `sql` from `drizzle-orm`) — delivery is entered from `authorized` (post-build-approval) and may pass through `running`. Keep the kill-safe intent (paused/halted excluded).

Add routing in `dispatcher.ts` — change the signature and delegate:
```ts
import { runCurrentPhase } from './orchestrator';
import { runDeliveryPhase } from './delivery';
import type { SandboxRunner } from '@/lib/sandbox-runner';
import type { DeployerClient } from '@/lib/deployer';
import type { ModelProvider } from '@/lib/model-provider';

export async function advanceRun(
  runId: string,
  provider: ModelProvider,
  db: Db = defaultDb,
  deps: { sandbox?: SandboxRunner; deployer?: DeployerClient } = {},
): Promise<{ ran: boolean; status: string; phase: string }> {
  const run = await db.query.agentDeliveryRuns.findFirst({ where: eq(agentDeliveryRuns.id, runId) });
  if (!run) throw new NotFoundError('Run');
  if (run.status !== 'authorized' && run.status !== 'running') {
    return { ran: false, status: run.status, phase: run.currentPhase };
  }
  if (run.currentPhase === 'delivery') {
    if (!deps.deployer) throw new InvalidStateError('Delivery phase requires a deployer.');
    const r = await runDeliveryPhase(runId, deps.deployer, db);
    const after = await db.query.agentDeliveryRuns.findFirst({ where: eq(agentDeliveryRuns.id, runId) });
    return { ran: r.status !== 'halted', status: after!.status, phase: after!.currentPhase };
  }
  const result = await runCurrentPhase(runId, provider, db, { sandbox: deps.sandbox });
  const after = await db.query.agentDeliveryRuns.findFirst({ where: eq(agentDeliveryRuns.id, runId) });
  return { ran: result.status !== 'skipped', status: after!.status, phase: after!.currentPhase };
}
```
(Add `InvalidStateError` to the `@/modules/identity` import in `dispatcher.ts`.) Export `runDeliveryPhase` from `index.ts`.

- [ ] **Step 4: Run — verify pass**, typecheck, commit:
```bash
npm run typecheck
git add src/modules/agent-delivery/delivery.ts src/modules/agent-delivery/dispatcher.ts src/modules/agent-delivery/index.ts src/modules/agent-delivery/delivery.integration.test.ts
git commit -m "feat(agent-delivery): delivery phase (staging deploy) + advanceRun routing"
```

---

### Task 5: `RunClosed` terminal event

**Files:**
- Modify: `src/modules/agent-delivery/service.ts`
- Test: `src/modules/agent-delivery/run-closed.integration.test.ts`

**Interfaces:**
- Changes: `approveMilestone` (on the final phase → `completed`), `rejectMilestone` (→ `failed`), and `setRunStatus` (→ `halted`) each additionally emit a `RunClosed` outbox event in the same tx, carrying `{ runId, computePledgeId, corporationOrgId, committedMinor, consumedMinor, currency, priceBookVersion, outcome }`. Billing subscribes later (Release 2); no consumer yet.

- [ ] **Step 1: Write the failing test**

`run-closed.integration.test.ts`: drive a run to the delivery gate, approve it (completing the run), and assert exactly one `RunClosed` outbox row with the run's id and `outcome: 'completed'`; separately, a rejected run emits `RunClosed` with `outcome: 'failed'`. (Reuse the `runToDelivery` helper shape; read `outbox` filtered by `eventType = 'RunClosed'`.)

- [ ] **Step 2: Run — verify it fails.**

- [ ] **Step 3: Implement**

Add a helper in `service.ts` that, given a `tx` and a run row + outcome, reads the run's budget (`runBudgets`) and inserts the `RunClosed` outbox event, then call it from the three terminal transitions:
```ts
async function emitRunClosed(tx: Executor, run: { id: string; computePledgeId: string; corporationOrgId: string; priceBookVersion: string }, outcome: 'completed' | 'failed' | 'halted') {
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
```
Call `emitRunClosed(tx, run, 'completed')` in `approveMilestone`'s no-next-phase branch (it already loads the run via `loadMilestoneAsCharityOwner` — use that `run`); `emitRunClosed(tx, run, 'failed')` in `rejectMilestone`; and in `setRunStatus`, when `status === 'halted'`, call `emitRunClosed(tx, run, 'halted')`. (`runBudgets` and `runBudgets` query are available via the schema import.)

- [ ] **Step 4: Run — verify pass**, typecheck, commit:
```bash
npm run typecheck
git add src/modules/agent-delivery/service.ts src/modules/agent-delivery/run-closed.integration.test.ts
git commit -m "feat(agent-delivery): RunClosed terminal event for Billing (R2 consumer)"
```

---

### Task 6: Provider factory + worker wiring

**Files:**
- Create: `src/lib/model-provider-factory.ts`
- Modify: `src/modules/notifications/relay.ts` (subscriber registry), `src/worker/index.ts` (queue + handler + reconciliation)
- Test: `src/lib/model-provider-factory.test.ts`, `src/modules/notifications/relay-agent-delivery.integration.test.ts`

**Interfaces:**
- Produces: `getModelProvider(name: string): ModelProvider` — `'fake'` → `new FakeModelProvider()`; anything else → throws `Error('model provider "<name>" is not configured (Slice 3b)')`. And a relay extension: after dispatching to Notifications, for the runnable-making agent-delivery events (`ComputePledgeAccepted`, `MilestoneApproved`, `MilestoneChangesRequested`, `RunStatusChanged`), call an injected `onAgentDeliveryEvent(runId)` callback (default no-op) so the worker can enqueue `agent.advance`. The pg-boss `agent.advance` handler + reconciliation `schedule` are registered in `src/worker/index.ts` (thin wiring, typecheck-verified; the real provider/sandbox/deployer construction is Slice 3b — the handler uses `getModelProvider(run.provider)` which throws for non-fake until then).

- [ ] **Step 1: Provider factory (unit, TDD)** — test that `'fake'` returns a `FakeModelProvider` and an unknown name throws; implement `src/lib/model-provider-factory.ts`.

- [ ] **Step 2: Relay subscriber hook (integration, TDD)** — extend `relayOutbox(db, limit, onAgentDeliveryEvent?)` so that when it publishes one of the four runnable-making events it invokes `onAgentDeliveryEvent(payload.runId)` (still inside the relay tx is fine — the callback only enqueues, it does NOT run a phase). Test: seed an unpublished `MilestoneApproved` outbox row, run `relayOutbox` with a spy callback, assert the callback received the runId and the row is marked published. Keep Notifications dispatch unchanged.

- [ ] **Step 3: Worker registration (typecheck-only wiring)** — in `src/worker/index.ts`: add an `agent.advance` queue; a `boss.work` handler that loads the run, builds `getModelProvider(run.provider)` + (Slice 3b) sandbox/deployer, and calls `advanceRun`; pass an `onAgentDeliveryEvent = (runId) => boss.send('agent.advance', { runId }, { singletonKey: runId })` into the relay `setInterval`; and a `boss.schedule('agent.advance.sweep', ...)`-style reconciliation that enqueues runnable runs. This is not integration-tested (needs a live pg-boss); it must `npm run typecheck` clean and is reviewed by reading. Add a `// Slice 3b:` comment where the real sandbox/deployer construction goes.

- [ ] **Step 4: Full gate + commit**

```bash
npm run typecheck && npm test && TEST_DATABASE_URL=postgres://hodorhub:hodorhub@localhost:5432/hodorhub_test DATABASE_URL=postgres://hodorhub:hodorhub@localhost:5432/hodorhub_test npm run test:integration
git add src/lib/model-provider-factory.ts src/lib/model-provider-factory.test.ts src/modules/notifications/relay.ts src/modules/notifications/relay-agent-delivery.integration.test.ts src/worker/index.ts
git commit -m "feat(agent-delivery): provider factory + worker wiring (relay enqueue + agent.advance + reconciliation)"
```

---

## What this slice delivers

A full run now flows **requirements → design → build → delivery** end-to-end on fakes: the build phase runs a worker model step + a sandbox build, the delivery phase deploys to a staging URL and records `deployed_environments`, every phase stops at its human gate, a terminal `RunClosed` event fires for Billing, and the pg-boss worker drives it via the relay + `agent.advance` + a reconciliation sweep. All offline-verifiable; no real model, sandbox, or deploy.

## Explicitly out of scope (Slice 3b)

Real `ModelProvider`/`SandboxRunner`/`DeployerClient` implementations; the isolated delivered-apps GCP project + microVM sandbox + egress lockdown; production promotion (US-11.8); Billing's `RunClosed`/`ComputePledgeAccepted` consumer; price-book cache-token calibration; eval corpora. The worker registration (Task 6 Step 3) is wired but only exercised for real once those land.

## Self-review notes

- **Kill-safety preserved:** build uses the same reserve→model→settle→CAS path; delivery uses the same CAS transition; neither weakens the ceiling (delivery has no spend).
- **Merit integrity:** `deployed_environments` added to the boundary guard (Task 1); no new Scoring reference.
- **Signature churn contained:** `runCurrentPhase`/`advanceRun` gain an optional trailing `deps` — existing requirements/design/dispatcher tests pass unchanged; only new build/delivery tests supply `deps`.
- **Type consistency:** `SandboxRunner`/`DeployerClient` names and the `deps: { sandbox?, deployer? }` shape are identical across orchestrator, delivery, and dispatcher.
