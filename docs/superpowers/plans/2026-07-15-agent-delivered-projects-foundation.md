# Agent-Delivered Projects — Foundation Slice Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Build the safety-first foundation of Epic 11 — a corporation-funded, budget-capped, human-gated agent-delivery run that executes its first phase (Requirements) against a *fake* model provider, provable end-to-end with no live LLM and no sandbox.

**Architecture:** A new `AgentDelivery` bounded context (`src/modules/agent-delivery/`), sibling to `Delivery`. Triggered by a new merit-blind `compute_pledges` aggregate in `Commitments`. Spend is bounded by a Postgres-backed **reserve-before-spend** ledger with a `CHECK` backstop, so overrun is impossible by construction. Model access is behind a swappable `ModelProvider` interface (mirrors `lib/mailer`), with a `FakeModelProvider` for tests. Agent activity is kept structurally out of Scoring.

**Tech Stack:** TypeScript (ESM, `@/` alias), Next.js 15, Drizzle ORM + Postgres, drizzle-kit migrations, pg-boss worker, zod, Vitest (unit config `vitest.config.ts`; integration `vitest.integration.config.ts`, needs `docker compose up -d db`).

## Global Constraints

- **Node ≥ 20**, `type: module` — all imports ESM, use the `@/` alias for `src`.
- **Service pattern:** every service function takes `actingUserId` first and an injectable executor last (`db: Db = defaultDb`), and does its own authorization via `findMembership` + role check. Cross-context access goes through a module's public interface (its `index.ts`), never another module's tables.
- **Error taxonomy:** reuse `NotFoundError`, `ForbiddenError`, `InvalidStateError` from `@/modules/identity`. Cross-tenant access returns `NotFoundError` (never leak existence); wrong-role returns `ForbiddenError`.
- **Events:** every state change that others react to writes an `outbox` row **in the same transaction** (`eventType`, `payload`).
- **Money unit:** integer **minor units** (pence); currency string defaults to `'GBP'`. Never floats for money.
- **Merit integrity (non-negotiable):** no file under `src/modules/agent-delivery`, and no new table it owns, may be referenced or imported by `engagement`, `scoring`, or `discovery`. Enforced by a structural test (Task 7).
- **Unit vs integration:** pure logic → `*.test.ts` (unit, DB-free). Anything touching the DB → `*.integration.test.ts`.

---

### Task 1: Model provider abstraction + FakeModelProvider

**Files:**
- Create: `src/lib/model-provider.ts`
- Create: `src/lib/fake-model-provider.ts`
- Test: `src/lib/fake-model-provider.test.ts`

**Interfaces:**
- Produces: `ModelTier = 'planner' | 'worker' | 'reviewer'`; `ModelUsage = { inputTokens: number; outputTokens: number; cacheTokens: number }`; `ModelRequest = { tier: ModelTier; system?: string; prompt: string; maxOutputTokens: number }`; `ModelResponse = { text: string; modelId: string; usage: ModelUsage; stopReason: 'end' | 'max_tokens' | 'stop_sequence' | 'refusal' }`; `interface ModelProvider { complete(req: ModelRequest): Promise<ModelResponse> }`; `class FakeModelProvider implements ModelProvider` with constructor `(scripts?: FakeScript[])`, public `calls: ModelRequest[]`, where `FakeScript = { text: string; usage?: Partial<ModelUsage>; modelId?: string; stopReason?: ModelResponse['stopReason'] }`.

- [ ] **Step 1: Write the interface module**

`src/lib/model-provider.ts`:
```ts
/**
 * Swappable model provider (mirrors lib/mailer, ADR 0001). Orchestration code
 * depends only on this interface — never a vendor SDK — so the provider is
 * swappable and the whole pipeline is testable with a fake. Every call reports
 * token usage so the budget ledger (agent-delivery) can meter spend.
 */
export type ModelTier = 'planner' | 'worker' | 'reviewer';

export interface ModelUsage {
  inputTokens: number;
  outputTokens: number;
  cacheTokens: number;
}

export interface ModelRequest {
  tier: ModelTier;
  system?: string;
  prompt: string;
  /** Hard cap on output tokens — priced at reservation so actual ≤ reserved. */
  maxOutputTokens: number;
}

export interface ModelResponse {
  text: string;
  modelId: string;
  usage: ModelUsage;
  stopReason: 'end' | 'max_tokens' | 'stop_sequence' | 'refusal';
}

export interface ModelProvider {
  complete(req: ModelRequest): Promise<ModelResponse>;
}
```

- [ ] **Step 2: Write the failing test**

`src/lib/fake-model-provider.test.ts`:
```ts
import { describe, it, expect } from 'vitest';
import { FakeModelProvider } from './fake-model-provider';

describe('FakeModelProvider', () => {
  it('returns scripted responses in order and records calls', async () => {
    const p = new FakeModelProvider([
      { text: 'first', usage: { outputTokens: 500 } },
      { text: 'second' },
    ]);
    const a = await p.complete({ tier: 'planner', prompt: 'x', maxOutputTokens: 1000 });
    const b = await p.complete({ tier: 'worker', prompt: 'y', maxOutputTokens: 1000 });
    expect(a.text).toBe('first');
    expect(a.usage.outputTokens).toBe(500);
    expect(b.text).toBe('second');
    expect(b.usage.outputTokens).toBe(200); // default
    expect(p.calls).toHaveLength(2);
    expect(p.calls[0]!.tier).toBe('planner');
  });

  it('falls back to a default response when the script is exhausted', async () => {
    const p = new FakeModelProvider();
    const r = await p.complete({ tier: 'reviewer', prompt: 'z', maxOutputTokens: 10 });
    expect(r.text).toBe('ok');
    expect(r.stopReason).toBe('end');
    expect(r.modelId).toBe('fake-reviewer');
  });
});
```

- [ ] **Step 3: Run test to verify it fails**

Run: `npm test -- src/lib/fake-model-provider.test.ts`
Expected: FAIL — cannot find module `./fake-model-provider`.

- [ ] **Step 4: Implement the fake provider**

`src/lib/fake-model-provider.ts`:
```ts
import type { ModelProvider, ModelRequest, ModelResponse, ModelUsage } from './model-provider';

export interface FakeScript {
  text: string;
  usage?: Partial<ModelUsage>;
  modelId?: string;
  stopReason?: ModelResponse['stopReason'];
}

/** Deterministic, scriptable ModelProvider for tests. No network, no cost. */
export class FakeModelProvider implements ModelProvider {
  private readonly queue: FakeScript[];
  public readonly calls: ModelRequest[] = [];

  constructor(scripts: FakeScript[] = []) {
    this.queue = [...scripts];
  }

  async complete(req: ModelRequest): Promise<ModelResponse> {
    this.calls.push(req);
    const s = this.queue.shift() ?? { text: 'ok' };
    return {
      text: s.text,
      modelId: s.modelId ?? `fake-${req.tier}`,
      usage: {
        inputTokens: s.usage?.inputTokens ?? 100,
        outputTokens: s.usage?.outputTokens ?? 200,
        cacheTokens: s.usage?.cacheTokens ?? 0,
      },
      stopReason: s.stopReason ?? 'end',
    };
  }
}
```

- [ ] **Step 5: Run test to verify it passes**

Run: `npm test -- src/lib/fake-model-provider.test.ts`
Expected: PASS (2 tests).

- [ ] **Step 6: Commit**

```bash
git add src/lib/model-provider.ts src/lib/fake-model-provider.ts src/lib/fake-model-provider.test.ts
git commit -m "feat(agent-delivery): model provider abstraction + fake provider"
```

---

### Task 2: Budget math (pure reserve/settle costing)

**Files:**
- Create: `src/modules/agent-delivery/budget-math.ts`
- Test: `src/modules/agent-delivery/budget-math.test.ts`

**Interfaces:**
- Consumes: `ModelTier`, `ModelUsage` from `@/lib/model-provider`.
- Produces: `PRICE_BOOK_VERSION: string`; `ModelRate = { inputPerMTokens: number; outputPerMTokens: number }` (minor units per 1,000,000 tokens); `priceBook: Record<ModelTier, ModelRate>`; `estimateMaxCostMinor(tier: ModelTier, promptTokens: number, maxOutputTokens: number, rates?: Record<ModelTier, ModelRate>): number`; `actualCostMinor(tier: ModelTier, usage: ModelUsage, rates?: Record<ModelTier, ModelRate>): number`.

- [ ] **Step 1: Write the failing test**

`src/modules/agent-delivery/budget-math.test.ts`:
```ts
import { describe, it, expect } from 'vitest';
import { estimateMaxCostMinor, actualCostMinor, priceBook } from './budget-math';

describe('budget-math', () => {
  it('estimates the worst-case (max output) cost in minor units', () => {
    // planner: 400 in / 2000 out per 1e6 tokens → 1000 in + 1000 out
    // = (1000*400 + 1000*2000)/1e6 = 2.4 → ceil 3
    expect(estimateMaxCostMinor('planner', 1000, 1000)).toBe(3);
  });

  it('never lets actual exceed the estimate when output stays within the cap', () => {
    const tier = 'worker' as const;
    const promptTokens = 5000;
    const maxOutputTokens = 4000;
    const estimate = estimateMaxCostMinor(tier, promptTokens, maxOutputTokens);
    const actual = actualCostMinor(tier, {
      inputTokens: promptTokens,
      outputTokens: 4000, // used the full cap
      cacheTokens: 0,
    });
    expect(actual).toBeLessThanOrEqual(estimate);
  });

  it('counts cache tokens at the input rate', () => {
    const withCache = actualCostMinor('reviewer', { inputTokens: 0, outputTokens: 0, cacheTokens: 1_000_000 });
    expect(withCache).toBe(priceBook.reviewer.inputPerMTokens);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npm test -- src/modules/agent-delivery/budget-math.test.ts`
Expected: FAIL — cannot find module `./budget-math`.

- [ ] **Step 3: Implement budget math**

`src/modules/agent-delivery/budget-math.ts`:
```ts
import type { ModelTier, ModelUsage } from '@/lib/model-provider';

/**
 * Price book: minor units (pence) per 1,000,000 tokens, per tier. Rates are
 * illustrative and pinned per-run by PRICE_BOOK_VERSION; calibrate against the
 * live provider before real spend. Reserve-before-spend prices output at the
 * requested max, so actual cost can never exceed the reserved estimate.
 */
export const PRICE_BOOK_VERSION = '2026-07';

export interface ModelRate {
  inputPerMTokens: number;
  outputPerMTokens: number;
}

export const priceBook: Record<ModelTier, ModelRate> = {
  planner: { inputPerMTokens: 400, outputPerMTokens: 2000 }, // Opus-class
  worker: { inputPerMTokens: 160, outputPerMTokens: 800 }, // Sonnet-class
  reviewer: { inputPerMTokens: 400, outputPerMTokens: 2000 }, // Opus-class
};

export function estimateMaxCostMinor(
  tier: ModelTier,
  promptTokens: number,
  maxOutputTokens: number,
  rates: Record<ModelTier, ModelRate> = priceBook,
): number {
  const r = rates[tier];
  return Math.ceil((promptTokens * r.inputPerMTokens + maxOutputTokens * r.outputPerMTokens) / 1_000_000);
}

export function actualCostMinor(
  tier: ModelTier,
  usage: ModelUsage,
  rates: Record<ModelTier, ModelRate> = priceBook,
): number {
  const r = rates[tier];
  const inputLike = usage.inputTokens + usage.cacheTokens;
  return Math.ceil((inputLike * r.inputPerMTokens + usage.outputTokens * r.outputPerMTokens) / 1_000_000);
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npm test -- src/modules/agent-delivery/budget-math.test.ts`
Expected: PASS (3 tests).

- [ ] **Step 5: Commit**

```bash
git add src/modules/agent-delivery/budget-math.ts src/modules/agent-delivery/budget-math.test.ts
git commit -m "feat(agent-delivery): reserve/settle budget math"
```

---

### Task 3: Schema — compute_pledges + agent-delivery tables + migration

**Files:**
- Modify: `src/db/schema.ts` (add enums near line 21–45; add tables after `resourceGifts`, ~line 350)
- Create (generated): `drizzle/NNNN_*.sql` via `npm run db:generate`

**Interfaces:**
- Produces (Drizzle tables/enums importable from `@/db/schema`): `computePledges`, `agentDeliveryRuns`, `runBudgets`, `runBudgetLedger`, `runMilestones`, `agentSteps`, and enums `computePledgeStatus`, `agentRunStatus`, `agentRunPhase`, `milestoneStatus`, `ledgerEntryType`.

- [ ] **Step 1: Add enums**

In `src/db/schema.ts`, after the existing `pgEnum` declarations (~line 45) add:
```ts
export const computePledgeStatus = pgEnum('compute_pledge_status', ['proposed', 'accepted', 'declined']);
export const agentRunStatus = pgEnum('agent_run_status', [
  'authorized',
  'running',
  'awaiting_gate',
  'paused',
  'halted',
  'completed',
  'failed',
]);
export const agentRunPhase = pgEnum('agent_run_phase', ['requirements', 'design', 'build', 'delivery']);
export const milestoneStatus = pgEnum('milestone_status', [
  'pending',
  'awaiting_review',
  'approved',
  'changes_requested',
  'rejected',
]);
export const ledgerEntryType = pgEnum('ledger_entry_type', ['reserve', 'settle', 'release']);
```

- [ ] **Step 2: Add the tables**

Add `check` to the `drizzle-orm/pg-core` import at the top of the file (line 1–12), then append after the `resourceGifts` table:
```ts
// ── Agent Delivery (Epic 11) ──────────────────────────────────────────────────
// Commitments sibling aggregate to `pledges`/`resource_gifts`: a corporation's
// FUNDED compute budget for agent delivery. Merit-blind (US-11.9) — never an
// input to scoring/discovery. Distinct from resource_gifts: HodorHub actively
// draws this budget down and escrows it.
export const computePledges = pgTable(
  'compute_pledges',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    projectId: uuid('project_id').notNull().references(() => projects.id),
    corporationOrgId: uuid('corporation_org_id').notNull().references(() => organisations.id),
    templateCode: text('template_code').notNull(),
    budgetCurrency: text('budget_currency').notNull().default('GBP'),
    budgetCommittedMinor: integer('budget_committed_minor').notNull(),
    status: computePledgeStatus('status').notNull().default('proposed'),
    decidedBy: uuid('decided_by').references(() => users.id),
    reason: text('reason'),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => ({
    oneAcceptedPerProject: uniqueIndex('compute_pledges_one_accepted_per_project')
      .on(t.projectId)
      .where(sql`${t.status} = 'accepted'`),
    positiveBudget: check('compute_pledges_budget_positive', sql`${t.budgetCommittedMinor} > 0`),
  }),
);

// AgentDelivery bounded context — owns the run lifecycle. Bi-tenant: charity
// owns/approves, corporation funds.
export const agentDeliveryRuns = pgTable('agent_delivery_runs', {
  id: uuid('id').primaryKey().defaultRandom(),
  projectId: uuid('project_id').notNull().references(() => projects.id),
  charityOrgId: uuid('charity_org_id').notNull().references(() => organisations.id),
  corporationOrgId: uuid('corporation_org_id').notNull().references(() => organisations.id),
  computePledgeId: uuid('compute_pledge_id').notNull().references(() => computePledges.id),
  templateCode: text('template_code').notNull(),
  provider: text('provider').notNull().default('fake'),
  priceBookVersion: text('price_book_version').notNull(),
  status: agentRunStatus('status').notNull().default('authorized'),
  currentPhase: agentRunPhase('current_phase').notNull().default('requirements'),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
});

// 1:1 materialised balance. The CHECK is the hard ceiling: runaway spend is
// impossible by construction (US-11.4).
export const runBudgets = pgTable(
  'run_budgets',
  {
    runId: uuid('run_id').primaryKey().references(() => agentDeliveryRuns.id),
    currency: text('currency').notNull().default('GBP'),
    committedMinor: integer('committed_minor').notNull(),
    reservedMinor: integer('reserved_minor').notNull().default(0),
    consumedMinor: integer('consumed_minor').notNull().default(0),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => ({
    withinCeiling: check(
      'run_budgets_within_ceiling',
      sql`${t.consumedMinor} + ${t.reservedMinor} <= ${t.committedMinor}`,
    ),
    nonNegative: check(
      'run_budgets_non_negative',
      sql`${t.reservedMinor} >= 0 AND ${t.consumedMinor} >= 0`,
    ),
  }),
);

// Append-only reserve-before-spend audit.
export const runBudgetLedger = pgTable('run_budget_ledger', {
  id: uuid('id').primaryKey().defaultRandom(),
  runId: uuid('run_id').notNull().references(() => agentDeliveryRuns.id),
  stepId: uuid('step_id'),
  entryType: ledgerEntryType('entry_type').notNull(),
  amountMinor: integer('amount_minor').notNull(),
  model: text('model'),
  inputTokens: integer('input_tokens'),
  outputTokens: integer('output_tokens'),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
});

// The human-in-the-loop gate. State machine mirrors hour_logs (US-6.2a).
export const runMilestones = pgTable(
  'run_milestones',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    runId: uuid('run_id').notNull().references(() => agentDeliveryRuns.id),
    phase: agentRunPhase('phase').notNull(),
    status: milestoneStatus('status').notNull().default('pending'),
    artifactRef: text('artifact_ref'),
    reviewerUserId: uuid('reviewer_user_id').references(() => users.id),
    reason: text('reason'),
    openedAt: timestamp('opened_at', { withTimezone: true }),
    decidedAt: timestamp('decided_at', { withTimezone: true }),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => ({ onePerPhase: unique('run_milestones_one_per_phase').on(t.runId, t.phase) }),
);

// Attribution + audit — NOT hours. Measured in tokens/cost, never converted.
export const agentSteps = pgTable('agent_steps', {
  id: uuid('id').primaryKey().defaultRandom(),
  runId: uuid('run_id').notNull().references(() => agentDeliveryRuns.id),
  phase: agentRunPhase('phase').notNull(),
  role: text('role').notNull(),
  stepIndex: integer('step_index').notNull(),
  inputTokens: integer('input_tokens').notNull().default(0),
  outputTokens: integer('output_tokens').notNull().default(0),
  costMinor: integer('cost_minor').notNull().default(0),
  status: text('status').notNull(),
  error: text('error'),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
});
```

- [ ] **Step 3: Generate the migration**

Run: `npm run db:generate`
Expected: a new `drizzle/NNNN_*.sql` file is created containing the new enums and tables. Open it and confirm it includes `CREATE TABLE "compute_pledges"`, `CREATE TABLE "run_budgets"`, and the two `CHECK` constraints (`run_budgets_within_ceiling`, `run_budgets_non_negative`).

- [ ] **Step 4: Typecheck**

Run: `npm run typecheck`
Expected: PASS (no errors) — confirms the Drizzle table definitions compile.

- [ ] **Step 5: Commit**

```bash
git add src/db/schema.ts drizzle/
git commit -m "feat(agent-delivery): compute_pledges + run tables + budget CHECK backstop"
```

---

### Task 4: Persisted budget service — reserve-before-spend

**Files:**
- Create: `src/modules/agent-delivery/budget.ts`
- Create: `src/modules/agent-delivery/errors.ts`
- Test: `src/modules/agent-delivery/budget.integration.test.ts`

**Interfaces:**
- Consumes: `agentDeliveryRuns`, `runBudgets`, `runBudgetLedger` from `@/db/schema`; `testDb` from `@/test/db`.
- Produces: `class BudgetExceededError extends Error`; `reserveStep(exec: Executor, runId: string, estimateMinor: number): Promise<void>` (throws `BudgetExceededError` if it would breach the ceiling); `settleStep(exec: Executor, runId: string, estimateMinor: number, actualMinor: number, meta: { model: string; inputTokens: number; outputTokens: number }): Promise<void>`; `getBalance(exec: Executor, runId: string): Promise<{ committedMinor: number; reservedMinor: number; consumedMinor: number; remainingMinor: number }>`.

- [ ] **Step 1: Write the error class**

`src/modules/agent-delivery/errors.ts`:
```ts
/** Raised when a step's reservation would breach the run's funded ceiling. */
export class BudgetExceededError extends Error {
  constructor(message = 'Insufficient remaining budget for the next step.') {
    super(message);
    this.name = 'BudgetExceededError';
  }
}
```

- [ ] **Step 2: Write the failing test**

`src/modules/agent-delivery/budget.integration.test.ts`:
```ts
import { describe, it, expect } from 'vitest';
import { testDb } from '@/test/db';
import { agentDeliveryRuns, runBudgets, computePledges, projects, organisations } from '@/db/schema';
import { reserveStep, settleStep, getBalance } from './budget';
import { BudgetExceededError } from './errors';

// Minimal fixture: a run with a £1.00 (100p) budget. Foreign keys require a
// project + orgs + compute_pledge to exist; insert the bare rows directly.
async function seedRun(committedMinor: number): Promise<string> {
  const [charity] = await testDb.insert(organisations).values({ name: 'C', type: 'charity', status: 'verified' }).returning();
  const [corp] = await testDb.insert(organisations).values({ name: 'Co', type: 'corporation', status: 'verified' }).returning();
  const [project] = await testDb.insert(projects).values({ charityOrgId: charity!.id, title: 'T', summary: 'S', category: 'software', status: 'in_delivery' }).returning();
  const [pledge] = await testDb.insert(computePledges).values({ projectId: project!.id, corporationOrgId: corp!.id, templateCode: 'static-site', budgetCommittedMinor: committedMinor, status: 'accepted' }).returning();
  const [run] = await testDb.insert(agentDeliveryRuns).values({ projectId: project!.id, charityOrgId: charity!.id, corporationOrgId: corp!.id, computePledgeId: pledge!.id, templateCode: 'static-site', priceBookVersion: '2026-07' }).returning();
  await testDb.insert(runBudgets).values({ runId: run!.id, committedMinor });
  return run!.id;
}

describe('agent-delivery budget (reserve-before-spend)', () => {
  it('reserves, settles at actual cost, and releases the difference', async () => {
    const runId = await seedRun(100);
    await reserveStep(testDb, runId, 40);
    await settleStep(testDb, runId, 40, 25, { model: 'fake', inputTokens: 100, outputTokens: 200 });
    const b = await getBalance(testDb, runId);
    expect(b.consumedMinor).toBe(25);
    expect(b.reservedMinor).toBe(0);
    expect(b.remainingMinor).toBe(75);
  });

  it('refuses a reservation that would breach the ceiling', async () => {
    const runId = await seedRun(100);
    await reserveStep(testDb, runId, 80);
    await expect(reserveStep(testDb, runId, 30)).rejects.toBeInstanceOf(BudgetExceededError);
    const b = await getBalance(testDb, runId);
    expect(b.reservedMinor).toBe(80); // unchanged by the refused reservation
  });
});
```

- [ ] **Step 3: Run test to verify it fails**

Run: `docker compose up -d db && npm run test:integration -- src/modules/agent-delivery/budget.integration.test.ts`
Expected: FAIL — cannot find module `./budget`.

- [ ] **Step 4: Implement the budget service**

`src/modules/agent-delivery/budget.ts`:
```ts
import { and, eq, sql } from 'drizzle-orm';
import { db as defaultDb } from '@/db';
import { runBudgets, runBudgetLedger } from '@/db/schema';
import { BudgetExceededError } from './errors';

type Db = typeof defaultDb;
type Tx = Parameters<Parameters<Db['transaction']>[0]>[0];
type Executor = Db | Tx;

/**
 * Reserve a step's worst-case cost BEFORE the model call. The conditional
 * UPDATE only succeeds while remaining >= estimate, so a step that can't be
 * afforded is never started (US-11.4). The run_budgets CHECK is the DB backstop.
 */
export async function reserveStep(exec: Executor, runId: string, estimateMinor: number): Promise<void> {
  const updated = await exec
    .update(runBudgets)
    .set({ reservedMinor: sql`${runBudgets.reservedMinor} + ${estimateMinor}`, updatedAt: new Date() })
    .where(
      and(
        eq(runBudgets.runId, runId),
        sql`${runBudgets.committedMinor} - ${runBudgets.consumedMinor} - ${runBudgets.reservedMinor} >= ${estimateMinor}`,
      ),
    )
    .returning({ runId: runBudgets.runId });
  if (updated.length === 0) throw new BudgetExceededError();
  await exec.insert(runBudgetLedger).values({ runId, entryType: 'reserve', amountMinor: estimateMinor });
}

/** Settle a reserved step at its actual cost, releasing the over-reservation. */
export async function settleStep(
  exec: Executor,
  runId: string,
  estimateMinor: number,
  actualMinor: number,
  meta: { model: string; inputTokens: number; outputTokens: number },
): Promise<void> {
  await exec
    .update(runBudgets)
    .set({
      reservedMinor: sql`${runBudgets.reservedMinor} - ${estimateMinor}`,
      consumedMinor: sql`${runBudgets.consumedMinor} + ${actualMinor}`,
      updatedAt: new Date(),
    })
    .where(eq(runBudgets.runId, runId));
  await exec.insert(runBudgetLedger).values({
    runId,
    entryType: 'settle',
    amountMinor: actualMinor,
    model: meta.model,
    inputTokens: meta.inputTokens,
    outputTokens: meta.outputTokens,
  });
}

export async function getBalance(exec: Executor, runId: string) {
  const row = await exec.query.runBudgets.findFirst({ where: eq(runBudgets.runId, runId) });
  if (!row) throw new Error(`No budget for run ${runId}`);
  return {
    committedMinor: row.committedMinor,
    reservedMinor: row.reservedMinor,
    consumedMinor: row.consumedMinor,
    remainingMinor: row.committedMinor - row.consumedMinor - row.reservedMinor,
  };
}
```

- [ ] **Step 5: Run test to verify it passes**

Run: `npm run test:integration -- src/modules/agent-delivery/budget.integration.test.ts`
Expected: PASS (2 tests).

- [ ] **Step 6: Commit**

```bash
git add src/modules/agent-delivery/budget.ts src/modules/agent-delivery/errors.ts src/modules/agent-delivery/budget.integration.test.ts
git commit -m "feat(agent-delivery): persisted reserve-before-spend budget service"
```

---

### Task 5: Compute-pledge trigger in Commitments (fund → authorise run)

**Files:**
- Create: `src/modules/agent-delivery/service.ts` (add `createRunFromPledge`)
- Create: `src/modules/agent-delivery/index.ts`
- Modify: `src/modules/commitments/service.ts` (add `fundComputeBudget`, `acceptComputePledge`)
- Modify: `src/modules/commitments/index.ts` (export the two new functions)
- Test: `src/modules/commitments/compute-pledges.integration.test.ts`

**Interfaces:**
- Consumes: `assertCorpManager`, `getProjectRef`, `beginDelivery`, `findMembership`, `NotFoundError`, `ForbiddenError`, `InvalidStateError`; `computePledges`, `agentDeliveryRuns`, `runBudgets`, `outbox` from `@/db/schema`; `PRICE_BOOK_VERSION` from `@/modules/agent-delivery/budget-math`.
- Produces: `fundComputeBudget(actingUserId, projectId, input: { corporationOrgId: string; templateCode: string; budgetMinor: number }, db?): Promise<{ computePledgeId: string }>`; `acceptComputePledge(actingUserId, computePledgeId, db?): Promise<{ runId: string }>`; and in agent-delivery `createRunFromPledge(tx, pledge: { id: string; projectId: string; corporationOrgId: string; templateCode: string; budgetCommittedMinor: number }, charityOrgId: string): Promise<{ runId: string }>`.

- [ ] **Step 1: Write `createRunFromPledge` in agent-delivery**

`src/modules/agent-delivery/service.ts`:
```ts
import { db as defaultDb } from '@/db';
import { agentDeliveryRuns, runBudgets } from '@/db/schema';
import { PRICE_BOOK_VERSION } from './budget-math';

type Db = typeof defaultDb;
type Tx = Parameters<Parameters<Db['transaction']>[0]>[0];
type Executor = Db | Tx;

/**
 * Called synchronously by Commitments when a charity accepts a compute pledge,
 * mirroring how acceptPledge calls Projects.beginDelivery — a cross-module
 * SERVICE call to the owning module, never a table write. Escrows the budget.
 */
export async function createRunFromPledge(
  exec: Executor,
  pledge: { id: string; projectId: string; corporationOrgId: string; templateCode: string; budgetCommittedMinor: number },
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
    })
    .returning({ id: agentDeliveryRuns.id });
  await exec.insert(runBudgets).values({ runId: run!.id, committedMinor: pledge.budgetCommittedMinor });
  return { runId: run!.id };
}
```

`src/modules/agent-delivery/index.ts`:
```ts
export { createRunFromPledge } from './service';
export { reserveStep, settleStep, getBalance } from './budget';
export { BudgetExceededError } from './errors';
```

- [ ] **Step 2: Write the failing test**

`src/modules/commitments/compute-pledges.integration.test.ts`:
```ts
import { describe, it, expect } from 'vitest';
import { eq } from 'drizzle-orm';
import { testDb } from '@/test/db';
import { computePledges, agentDeliveryRuns, runBudgets, outbox } from '@/db/schema';
import {
  registerCharity, registerCorporation, approveVerification, createPlatformAdmin, NotFoundError,
} from '@/modules/identity';
import { createDraftProject, setResourceNeeds, publishProject } from '@/modules/projects';
import { fundComputeBudget, acceptComputePledge } from './service';

async function scenario() {
  const admin = await createPlatformAdmin('admin@hh.com', 'admin-password-1', testDb);
  const charity = await registerCharity({ email: 'petra@goodcause.org', password: 'a-strong-password', charityName: 'Good Cause', regNumber: 'CH-1' }, testDb);
  const corp = await registerCorporation({ email: 'carlos@acme.com', password: 'a-strong-password', companyName: 'Acme', emailDomain: 'acme.com' }, testDb);
  await approveVerification(charity.verificationRequestId, admin, testDb);
  await approveVerification(corp.verificationRequestId, admin, testDb);
  const project = await createDraftProject(charity.userId, { charityOrgId: charity.organisationId, title: 'Portal', description: 'A worthy cause that needs a hand.', goal: 'Reach the finish line.', category: 'software' }, testDb);
  await setResourceNeeds(charity.userId, project.projectId, [{ skill: 'Backend', role: 'Dev', kind: 'ongoing', quantity: 1, hoursPerWeek: 2, durationWeeks: 8 }], testDb);
  await publishProject(charity.userId, project.projectId, testDb);
  return { charity, corp, project };
}

describe('compute pledges (Epic 11 trigger)', () => {
  it('funds a budget then authorises a run + escrows it on acceptance', async () => {
    const { charity, corp, project } = await scenario();
    const { computePledgeId } = await fundComputeBudget(corp.userId, project.projectId, { corporationOrgId: corp.organisationId, templateCode: 'static-site', budgetMinor: 5000 }, testDb);
    const { runId } = await acceptComputePledge(charity.userId, computePledgeId, testDb);

    const pledge = await testDb.query.computePledges.findFirst({ where: eq(computePledges.id, computePledgeId) });
    expect(pledge!.status).toBe('accepted');
    const run = await testDb.query.agentDeliveryRuns.findFirst({ where: eq(agentDeliveryRuns.id, runId) });
    expect(run!.status).toBe('authorized');
    const budget = await testDb.query.runBudgets.findFirst({ where: eq(runBudgets.runId, runId) });
    expect(budget!.committedMinor).toBe(5000);
    const events = await testDb.select().from(outbox).where(eq(outbox.eventType, 'ComputePledgeAccepted'));
    expect(events).toHaveLength(1);
  });

  it('a different charity cannot accept the pledge', async () => {
    const { corp, project } = await scenario();
    const other = await registerCharity({ email: 'x@other.org', password: 'a-strong-password', charityName: 'Other', regNumber: 'CH-2' }, testDb);
    const { computePledgeId } = await fundComputeBudget(corp.userId, project.projectId, { corporationOrgId: corp.organisationId, templateCode: 'static-site', budgetMinor: 5000 }, testDb);
    await expect(acceptComputePledge(other.userId, computePledgeId, testDb)).rejects.toBeInstanceOf(NotFoundError);
  });
});
```

- [ ] **Step 3: Run test to verify it fails**

Run: `npm run test:integration -- src/modules/commitments/compute-pledges.integration.test.ts`
Expected: FAIL — `fundComputeBudget`/`acceptComputePledge` not exported.

- [ ] **Step 4: Implement the Commitments functions**

Add to `src/modules/commitments/service.ts` (import `computePledges` and `agentDeliveryRuns` from `@/db/schema`, `createRunFromPledge` from `@/modules/agent-delivery`, and `z`):
```ts
export const computeBudgetSchema = z.object({
  corporationOrgId: z.string().uuid(),
  templateCode: z.enum(['static-site']), // MVP allow-list (US-11.12); widen as evals prove shapes
  budgetMinor: z.number().int().min(1).max(10_000_00),
});
export type ComputeBudgetInput = z.infer<typeof computeBudgetSchema>;

/** US-11.1 — a CSR manager funds a compute budget for a published project. */
export async function fundComputeBudget(
  actingUserId: string,
  projectId: string,
  input: ComputeBudgetInput,
  db: Db = defaultDb,
): Promise<{ computePledgeId: string }> {
  const v = computeBudgetSchema.parse(input);
  return db.transaction(async (tx) => {
    await assertCorpManager(tx, actingUserId, v.corporationOrgId);
    const ref = await getProjectRef(projectId, tx);
    if (!ref) throw new NotFoundError('Project');
    if (ref.status !== 'published') throw new InvalidStateError('Project is not open for funding.');
    const [row] = await tx
      .insert(computePledges)
      .values({
        projectId,
        corporationOrgId: v.corporationOrgId,
        templateCode: v.templateCode,
        budgetCommittedMinor: v.budgetMinor,
      })
      .returning({ id: computePledges.id });
    return { computePledgeId: row!.id };
  });
}

/** US-11.2 — the charity accepts a compute pledge; a run is authorised + escrowed. */
export async function acceptComputePledge(
  actingUserId: string,
  computePledgeId: string,
  db: Db = defaultDb,
): Promise<{ runId: string }> {
  return db.transaction(async (tx) => {
    const pledge = await tx.query.computePledges.findFirst({ where: eq(computePledges.id, computePledgeId) });
    if (!pledge) throw new NotFoundError('Compute pledge');
    const ref = await getProjectRef(pledge.projectId, tx);
    if (!ref) throw new NotFoundError('Compute pledge');
    const m = await findMembership(actingUserId, ref.charityOrgId, tx);
    if (!m) throw new NotFoundError('Compute pledge'); // cross-tenant: no existence leak
    if (m.role !== 'charity_owner') throw new ForbiddenError();
    if (pledge.status !== 'proposed') throw new InvalidStateError(`Compute pledge already ${pledge.status}.`);

    await tx.update(computePledges).set({ status: 'accepted', decidedBy: actingUserId }).where(eq(computePledges.id, computePledgeId));
    await beginDelivery(pledge.projectId, tx);
    const { runId } = await createRunFromPledge(
      tx,
      { id: pledge.id, projectId: pledge.projectId, corporationOrgId: pledge.corporationOrgId, templateCode: pledge.templateCode, budgetCommittedMinor: pledge.budgetCommittedMinor },
      ref.charityOrgId,
    );
    await tx.insert(outbox).values({
      eventType: 'ComputePledgeAccepted',
      payload: { computePledgeId, projectId: pledge.projectId, corporationOrgId: pledge.corporationOrgId, runId },
    });
    return { runId };
  });
}
```

Add to `src/modules/commitments/index.ts`:
```ts
export { fundComputeBudget, acceptComputePledge } from './service';
```

- [ ] **Step 5: Run test to verify it passes**

Run: `npm run test:integration -- src/modules/commitments/compute-pledges.integration.test.ts`
Expected: PASS (2 tests).

- [ ] **Step 6: Typecheck + commit**

```bash
npm run typecheck
git add src/modules/agent-delivery/service.ts src/modules/agent-delivery/index.ts src/modules/commitments/service.ts src/modules/commitments/index.ts src/modules/commitments/compute-pledges.integration.test.ts
git commit -m "feat(agent-delivery): fund + accept compute pledge → authorise escrowed run"
```

---

### Task 6: Orchestrator (Requirements phase) + milestone gate

**Files:**
- Create: `src/modules/agent-delivery/orchestrator.ts`
- Modify: `src/modules/agent-delivery/service.ts` (add gate functions + `setRunStatus`)
- Modify: `src/modules/agent-delivery/index.ts` (export new functions)
- Test: `src/modules/agent-delivery/orchestrator.integration.test.ts`

**Interfaces:**
- Consumes: `ModelProvider` from `@/lib/model-provider`; `reserveStep`, `settleStep` from `./budget`; `estimateMaxCostMinor`, `actualCostMinor` from `./budget-math`; `BudgetExceededError` from `./errors`; `agentDeliveryRuns`, `runMilestones`, `agentSteps`, `outbox` from `@/db/schema`; `findMembership`, `NotFoundError`, `ForbiddenError`, `InvalidStateError` from `@/modules/identity`.
- Produces: `runRequirementsPhase(runId: string, provider: ModelProvider, db?): Promise<{ milestoneId: string; status: 'awaiting_review' | 'halted' }>`; `approveMilestone(actingUserId, milestoneId, db?): Promise<void>`; `requestChanges(actingUserId, milestoneId, feedback: string, db?): Promise<void>`; `rejectMilestone(actingUserId, milestoneId, reason: string, db?): Promise<void>`; `setRunStatus(actingUserId, runId, status: 'paused' | 'running' | 'halted', db?): Promise<void>`.

- [ ] **Step 1: Write the failing test**

`src/modules/agent-delivery/orchestrator.integration.test.ts`:
```ts
import { describe, it, expect } from 'vitest';
import { eq } from 'drizzle-orm';
import { testDb } from '@/test/db';
import { runMilestones, agentDeliveryRuns, outbox } from '@/db/schema';
import { FakeModelProvider } from '@/lib/fake-model-provider';
import { fundComputeBudget, acceptComputePledge } from '@/modules/commitments';
import {
  registerCharity, registerCorporation, approveVerification, createPlatformAdmin,
} from '@/modules/identity';
import { createDraftProject, setResourceNeeds, publishProject } from '@/modules/projects';
import { runRequirementsPhase, approveMilestone, requestChanges } from './orchestrator';
import { getBalance } from './budget';

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

describe('agent-delivery orchestrator — requirements phase + gate', () => {
  it('runs the phase within budget, opens a gate, and advances on approval', async () => {
    const { charity, runId } = await authorisedRun(5000);
    const provider = new FakeModelProvider([{ text: 'GIVEN a visitor WHEN they open the site THEN they see the mission', usage: { inputTokens: 300, outputTokens: 400 } }]);
    const res = await runRequirementsPhase(runId, provider, testDb);
    expect(res.status).toBe('awaiting_review');

    const balance = await getBalance(testDb, runId);
    expect(balance.consumedMinor).toBeGreaterThan(0);
    expect(balance.reservedMinor).toBe(0);

    await approveMilestone(charity.userId, res.milestoneId, testDb);
    const run = await testDb.query.agentDeliveryRuns.findFirst({ where: eq(agentDeliveryRuns.id, runId) });
    expect(run!.currentPhase).toBe('design');
    const events = await testDb.select().from(outbox).where(eq(outbox.eventType, 'MilestoneApproved'));
    expect(events).toHaveLength(1);
  });

  it('halts the run instead of overspending when the budget is tiny', async () => {
    const { runId } = await authorisedRun(1); // 1p — cannot afford a planner step
    const provider = new FakeModelProvider([{ text: 'x' }]);
    const res = await runRequirementsPhase(runId, provider, testDb);
    expect(res.status).toBe('halted');
    const run = await testDb.query.agentDeliveryRuns.findFirst({ where: eq(agentDeliveryRuns.id, runId) });
    expect(run!.status).toBe('halted');
    expect(provider.calls).toHaveLength(0); // never called the model — reserve failed first
  });

  it('request-changes loops the phase back to running', async () => {
    const { charity, runId } = await authorisedRun(5000);
    const provider = new FakeModelProvider([{ text: 'draft one' }]);
    const res = await runRequirementsPhase(runId, provider, testDb);
    await requestChanges(charity.userId, res.milestoneId, 'Add an accessibility criterion', testDb);
    const ms = await testDb.query.runMilestones.findFirst({ where: eq(runMilestones.id, res.milestoneId) });
    expect(ms!.status).toBe('changes_requested');
    const run = await testDb.query.agentDeliveryRuns.findFirst({ where: eq(agentDeliveryRuns.id, runId) });
    expect(run!.status).toBe('running');
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npm run test:integration -- src/modules/agent-delivery/orchestrator.integration.test.ts`
Expected: FAIL — cannot find module `./orchestrator`.

- [ ] **Step 3: Implement the orchestrator**

`src/modules/agent-delivery/orchestrator.ts`:
```ts
import { eq } from 'drizzle-orm';
import { db as defaultDb } from '@/db';
import { agentDeliveryRuns, runMilestones, agentSteps } from '@/db/schema';
import type { ModelProvider } from '@/lib/model-provider';
import { estimateMaxCostMinor, actualCostMinor } from './budget-math';
import { reserveStep, settleStep } from './budget';
import { BudgetExceededError } from './errors';

type Db = typeof defaultDb;

const REQUIREMENTS_MAX_OUTPUT = 2000;
const REQUIREMENTS_PROMPT_TOKENS = 1200; // conservative fixed estimate for the fixed brief

/**
 * Runs the Requirements phase against the provider, metered by the budget.
 * Deterministic control flow; the model is the only non-deterministic part.
 * Kill-switch/affordability are checked BEFORE the model call, so an
 * unaffordable or paused run halts without spending (US-11.4, US-11.5).
 */
export async function runRequirementsPhase(
  runId: string,
  provider: ModelProvider,
  db: Db = defaultDb,
): Promise<{ milestoneId: string; status: 'awaiting_review' | 'halted' }> {
  const run = await db.query.agentDeliveryRuns.findFirst({ where: eq(agentDeliveryRuns.id, runId) });
  if (!run) throw new Error(`No run ${runId}`);
  if (run.status === 'paused' || run.status === 'halted') {
    return { milestoneId: '', status: 'halted' };
  }

  const estimate = estimateMaxCostMinor('planner', REQUIREMENTS_PROMPT_TOKENS, REQUIREMENTS_MAX_OUTPUT);

  // Reserve first, in its own tx. If it can't be afforded, halt — no model call.
  try {
    await db.transaction(async (tx) => {
      await tx.update(agentDeliveryRuns).set({ status: 'running', updatedAt: new Date() }).where(eq(agentDeliveryRuns.id, runId));
      await reserveStep(tx, runId, estimate);
    });
  } catch (e) {
    if (e instanceof BudgetExceededError) {
      await db.update(agentDeliveryRuns).set({ status: 'halted', updatedAt: new Date() }).where(eq(agentDeliveryRuns.id, runId));
      return { milestoneId: '', status: 'halted' };
    }
    throw e;
  }

  const response = await provider.complete({
    tier: 'planner',
    system: 'You are the requirements planner. Emit machine-checkable acceptance criteria.',
    prompt: `Produce given/when/then acceptance criteria for template ${run.templateCode}.`,
    maxOutputTokens: REQUIREMENTS_MAX_OUTPUT,
  });
  const actual = actualCostMinor('planner', response.usage);

  return db.transaction(async (tx) => {
    await settleStep(tx, runId, estimate, actual, {
      model: response.modelId,
      inputTokens: response.usage.inputTokens,
      outputTokens: response.usage.outputTokens,
    });
    await tx.insert(agentSteps).values({
      runId, phase: 'requirements', role: 'planner', stepIndex: 0,
      inputTokens: response.usage.inputTokens, outputTokens: response.usage.outputTokens,
      costMinor: actual, status: 'ok',
    });
    const [ms] = await tx
      .insert(runMilestones)
      .values({ runId, phase: 'requirements', status: 'awaiting_review', artifactRef: response.text, openedAt: new Date() })
      .onConflictDoUpdate({
        target: [runMilestones.runId, runMilestones.phase],
        set: { status: 'awaiting_review', artifactRef: response.text, openedAt: new Date(), reason: null, decidedAt: null },
      })
      .returning({ id: runMilestones.id });
    await tx.update(agentDeliveryRuns).set({ status: 'awaiting_gate', updatedAt: new Date() }).where(eq(agentDeliveryRuns.id, runId));
    return { milestoneId: ms!.id, status: 'awaiting_review' as const };
  });
}
```

- [ ] **Step 4: Implement the gate functions**

Append to `src/modules/agent-delivery/service.ts` (add imports: `eq` from `drizzle-orm`; `runMilestones`, `outbox` from `@/db/schema`; `findMembership`, `NotFoundError`, `ForbiddenError`, `InvalidStateError` from `@/modules/identity`; and the ordered phase list):
```ts
import { eq } from 'drizzle-orm';
import { runMilestones, outbox } from '@/db/schema';
import { findMembership, NotFoundError, ForbiddenError, InvalidStateError } from '@/modules/identity';

const PHASE_ORDER = ['requirements', 'design', 'build', 'delivery'] as const;
type Phase = (typeof PHASE_ORDER)[number];

/** Load a milestone as the charity owner of its run; cross-tenant → NotFound. */
async function loadMilestoneAsCharityOwner(exec: Executor, userId: string, milestoneId: string) {
  const ms = await exec.query.runMilestones.findFirst({ where: eq(runMilestones.id, milestoneId) });
  if (!ms) throw new NotFoundError('Milestone');
  const run = await exec.query.agentDeliveryRuns.findFirst({ where: eq(agentDeliveryRuns.id, ms.runId) });
  if (!run) throw new NotFoundError('Milestone');
  const m = await findMembership(userId, run.charityOrgId, exec);
  if (!m) throw new NotFoundError('Milestone'); // no existence leak to another tenant
  if (m.role !== 'charity_owner') throw new ForbiddenError();
  return { ms, run };
}

/** US-11.3 — charity approves a phase; the next phase begins (or the run completes). */
export async function approveMilestone(actingUserId: string, milestoneId: string, db: Db = defaultDb): Promise<void> {
  await db.transaction(async (tx) => {
    const { ms } = await loadMilestoneAsCharityOwner(tx, actingUserId, milestoneId);
    if (ms.status !== 'awaiting_review') throw new InvalidStateError(`Milestone already ${ms.status}.`);
    await tx.update(runMilestones).set({ status: 'approved', reviewerUserId: actingUserId, decidedAt: new Date() }).where(eq(runMilestones.id, milestoneId));
    const idx = PHASE_ORDER.indexOf(ms.phase as Phase);
    const next = PHASE_ORDER[idx + 1];
    if (next) {
      await tx.update(agentDeliveryRuns).set({ currentPhase: next, status: 'authorized', updatedAt: new Date() }).where(eq(agentDeliveryRuns.id, ms.runId));
    } else {
      await tx.update(agentDeliveryRuns).set({ status: 'completed', updatedAt: new Date() }).where(eq(agentDeliveryRuns.id, ms.runId));
    }
    await tx.insert(outbox).values({ eventType: 'MilestoneApproved', payload: { milestoneId, runId: ms.runId, phase: ms.phase } });
  });
}

/** US-11.3 — charity requests changes; the phase loops back to running for a revise cycle. */
export async function requestChanges(actingUserId: string, milestoneId: string, feedback: string, db: Db = defaultDb): Promise<void> {
  await db.transaction(async (tx) => {
    const { ms } = await loadMilestoneAsCharityOwner(tx, actingUserId, milestoneId);
    if (ms.status !== 'awaiting_review') throw new InvalidStateError(`Milestone already ${ms.status}.`);
    await tx.update(runMilestones).set({ status: 'changes_requested', reviewerUserId: actingUserId, reason: feedback, decidedAt: new Date() }).where(eq(runMilestones.id, milestoneId));
    await tx.update(agentDeliveryRuns).set({ status: 'running', updatedAt: new Date() }).where(eq(agentDeliveryRuns.id, ms.runId));
    await tx.insert(outbox).values({ eventType: 'MilestoneChangesRequested', payload: { milestoneId, runId: ms.runId, phase: ms.phase } });
  });
}

/** US-11.3 — charity rejects; the run stops. */
export async function rejectMilestone(actingUserId: string, milestoneId: string, reason: string, db: Db = defaultDb): Promise<void> {
  await db.transaction(async (tx) => {
    const { ms } = await loadMilestoneAsCharityOwner(tx, actingUserId, milestoneId);
    if (ms.status !== 'awaiting_review') throw new InvalidStateError(`Milestone already ${ms.status}.`);
    await tx.update(runMilestones).set({ status: 'rejected', reviewerUserId: actingUserId, reason, decidedAt: new Date() }).where(eq(runMilestones.id, milestoneId));
    await tx.update(agentDeliveryRuns).set({ status: 'failed', updatedAt: new Date() }).where(eq(agentDeliveryRuns.id, ms.runId));
    await tx.insert(outbox).values({ eventType: 'MilestoneRejected', payload: { milestoneId, runId: ms.runId, phase: ms.phase } });
  });
}
```

Add exports to `src/modules/agent-delivery/index.ts`:
```ts
export { runRequirementsPhase } from './orchestrator';
export { createRunFromPledge, approveMilestone, requestChanges, rejectMilestone } from './service';
```

- [ ] **Step 5: Run test to verify it passes**

Run: `npm run test:integration -- src/modules/agent-delivery/orchestrator.integration.test.ts`
Expected: PASS (3 tests). The tiny-budget case proves the model is never called when the step can't be afforded.

- [ ] **Step 6: Typecheck + commit**

```bash
npm run typecheck
git add src/modules/agent-delivery/orchestrator.ts src/modules/agent-delivery/service.ts src/modules/agent-delivery/index.ts src/modules/agent-delivery/orchestrator.integration.test.ts
git commit -m "feat(agent-delivery): requirements phase orchestrator + milestone gate cycle"
```

---

### Task 7: Kill switch + merit-integrity structural guard

**Files:**
- Modify: `src/modules/agent-delivery/service.ts` (add `setRunStatus`)
- Modify: `src/modules/agent-delivery/index.ts` (export `setRunStatus`)
- Modify: `src/modules/scoring-boundary.test.ts` (extend the forbidden tokens + imports)
- Test: `src/modules/agent-delivery/merit-integrity.integration.test.ts`

**Interfaces:**
- Consumes: everything from Tasks 5–6; `projectScores`, `engagementEvents` from `@/db/schema`; admin helpers from `@/modules/identity` (`createPlatformAdmin`).
- Produces: `setRunStatus(actingUserId: string, runId: string, status: 'paused' | 'running' | 'halted', db?): Promise<void>` (platform-admin only — the kill switch).

- [ ] **Step 1: Extend the structural boundary test (write it failing)**

In `src/modules/scoring-boundary.test.ts`, add these two `it` blocks inside the existing `describe`:
```ts
it('scoring/discovery source never references agent-delivery run tables', () => {
  const forbidden = /agent_delivery_runs|agentDeliveryRuns|run_budgets|runBudgets|run_budget_ledger|run_milestones|runMilestones|agent_steps|agentSteps|compute_pledges|computePledges/;
  for (const f of [
    'src/modules/engagement/service.ts',
    'src/modules/engagement/social.ts',
    'src/modules/scoring/service.ts',
    'src/modules/discovery/service.ts',
  ]) {
    expect(read(f)).not.toMatch(forbidden);
  }
});

it('scoring/discovery source never imports from @/modules/agent-delivery', () => {
  for (const f of [
    'src/modules/engagement/service.ts',
    'src/modules/engagement/social.ts',
    'src/modules/scoring/service.ts',
    'src/modules/discovery/service.ts',
  ]) {
    expect(read(f)).not.toMatch(/from ['"]@\/modules\/agent-delivery['"]/);
  }
});
```

- [ ] **Step 2: Run the boundary test**

Run: `npm test -- src/modules/scoring-boundary.test.ts`
Expected: PASS immediately — scoring/discovery don't reference agent-delivery yet. This test is a *guard* that fails the day someone introduces a leak. (If it fails now, a leak already exists — stop and fix the source, not the test.)

- [ ] **Step 3: Write the failing merit-integrity + kill-switch behavioural test**

`src/modules/agent-delivery/merit-integrity.integration.test.ts`:
```ts
import { describe, it, expect } from 'vitest';
import { eq } from 'drizzle-orm';
import { testDb } from '@/test/db';
import { projectScores, engagementEvents, agentDeliveryRuns } from '@/db/schema';
import { FakeModelProvider } from '@/lib/fake-model-provider';
import { fundComputeBudget, acceptComputePledge } from '@/modules/commitments';
import { registerCharity, registerCorporation, approveVerification, createPlatformAdmin } from '@/modules/identity';
import { createDraftProject, setResourceNeeds, publishProject } from '@/modules/projects';
import { runRequirementsPhase, approveMilestone, setRunStatus } from '.';

async function fixture(budgetMinor: number) {
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
  return { admin, charity, project, runId };
}

describe('agent-delivery merit integrity + kill switch', () => {
  it('a full agent run changes zero score/engagement rows for the project', async () => {
    const { charity, project, runId } = await fixture(5000);
    const res = await runRequirementsPhase(runId, new FakeModelProvider([{ text: 'criteria' }]), testDb);
    await approveMilestone(charity.userId, res.milestoneId, testDb);

    const scores = await testDb.select().from(projectScores).where(eq(projectScores.projectId, project.projectId));
    const events = await testDb.select().from(engagementEvents).where(eq(engagementEvents.projectId, project.projectId));
    expect(scores).toHaveLength(0); // agent activity never wrote a score
    expect(events).toHaveLength(0);
  });

  it('an admin kill switch halts a run', async () => {
    const { admin, runId } = await fixture(5000);
    await setRunStatus(admin, runId, 'halted', testDb);
    const run = await testDb.query.agentDeliveryRuns.findFirst({ where: eq(agentDeliveryRuns.id, runId) });
    expect(run!.status).toBe('halted');
    // a halted run refuses to execute a phase (no model call)
    const provider = new FakeModelProvider([{ text: 'x' }]);
    const res = await runRequirementsPhase(runId, provider, testDb);
    expect(res.status).toBe('halted');
    expect(provider.calls).toHaveLength(0);
  });
});
```

- [ ] **Step 4: Run to verify it fails**

Run: `npm run test:integration -- src/modules/agent-delivery/merit-integrity.integration.test.ts`
Expected: FAIL — `setRunStatus` not exported.

- [ ] **Step 5: Implement `setRunStatus` (kill switch)**

Append to `src/modules/agent-delivery/service.ts` (add `isPlatformAdmin` and `ForbiddenError` to the `@/modules/identity` import if not already imported):
```ts
import { isPlatformAdmin, ForbiddenError } from '@/modules/identity';

/** US-11.5 — platform admin kill switch: pause/halt/resume a run. */
export async function setRunStatus(
  actingUserId: string,
  runId: string,
  status: 'paused' | 'running' | 'halted',
  db: Db = defaultDb,
): Promise<void> {
  await db.transaction(async (tx) => {
    if (!(await isPlatformAdmin(actingUserId, tx))) throw new ForbiddenError('Admin access required.');
    const run = await tx.query.agentDeliveryRuns.findFirst({ where: eq(agentDeliveryRuns.id, runId) });
    if (!run) throw new NotFoundError('Run');
    await tx.update(agentDeliveryRuns).set({ status, updatedAt: new Date() }).where(eq(agentDeliveryRuns.id, runId));
    await tx.insert(outbox).values({ eventType: 'RunStatusChanged', payload: { runId, status, by: actingUserId } });
  });
}
```
Add `export { setRunStatus } from './service';` to `src/modules/agent-delivery/index.ts`.

> **Service-layer admin check:** use `isPlatformAdmin(userId, exec)` from `@/modules/identity` (the helper `moderation/service.ts` wraps in its `assertAdmin`) and throw `ForbiddenError` — NOT `requirePlatformAdmin` from `@/lib/auth`, which is session-based/HTTP-only (takes no userId). NOTE: a `setRunStatus` may already exist from Task 6 with the WRONG (charity_owner) authorization; if so, REPLACE it entirely with this platform-admin version.

- [ ] **Step 6: Run to verify it passes**

Run: `npm run test:integration -- src/modules/agent-delivery/merit-integrity.integration.test.ts`
Expected: PASS (2 tests).

- [ ] **Step 7: Full suite + typecheck**

Run: `npm run typecheck && npm test && npm run test:integration`
Expected: all green (unit + integration).

- [ ] **Step 8: Commit**

```bash
git add src/modules/agent-delivery/service.ts src/modules/agent-delivery/index.ts src/modules/scoring-boundary.test.ts src/modules/agent-delivery/merit-integrity.integration.test.ts
git commit -m "feat(agent-delivery): admin kill switch + merit-integrity structural guard"
```

---

## What this slice delivers

A corporation can fund a budget; a charity can accept it, authorising a budget-escrowed run; the run executes its Requirements phase against a fake model **without ever exceeding the funded ceiling** (proven by the tiny-budget halt test); the charity approves / requests-changes / rejects at the gate; an admin can halt any run; and agent activity provably writes **zero** score/engagement rows. All of it runs offline — no live LLM, no sandbox.

## Explicitly out of scope (follow-up plan)

Design + Build + Delivery phases; the real microVM sandbox and tool contracts; the privileged deployer + staging URL (US-11.7) and prod promotion (US-11.8); the independent reviewer agent; HTTP route handlers under `src/app/api/agent-runs/**` and the UI; Notifications wiring of the new events (the outbox rows are written; the relay fan-out to a second subscriber is a separate change, see ARCHITECTURE.md §8); real provider adapters; ADR 0003 (delivered-app isolation).

## Self-review notes

- **Spec coverage:** US-11.1 (Task 5 fund), US-11.2 (Task 5 accept→run+escrow), US-11.3 (Task 6 gate cycle), US-11.4 (Tasks 2+4+6 reserve-before-spend + halt), US-11.5 (Task 7 kill switch), US-11.9 (Task 7 structural + behavioural), US-11.12 (Task 5 template allow-list via the zod enum). US-11.6/7/8/10/11 are deliberately in the follow-up plan (sandbox, deploy, attribution reporting, synthetic-data harness).
- **Type consistency:** `reserveStep`/`settleStep`/`getBalance` signatures match across Tasks 4/6/7; `createRunFromPledge` matches its caller in Task 5; milestone status/enum strings match the schema in Task 3.
- **Assumption to verify during Task 5:** `registerCharity`/`registerCorporation`/`createDraftProject`/`setResourceNeeds`/`publishProject` argument shapes are taken from `resource-gifts.integration.test.ts`; confirm against the current signatures in `@/modules/identity` and `@/modules/projects` and adjust the fixture if they've changed.
