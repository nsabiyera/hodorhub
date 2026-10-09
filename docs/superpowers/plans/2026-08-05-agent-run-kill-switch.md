# Admin Run Controls & Kill Switch (US-11.5) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Give a platform admin working controls to pause, resume, or halt a single agent-delivery run, plus a reversible platform-wide brake that stops every run at its next step boundary.

**Architecture:** The domain layer for per-run control already exists (`setRunStatus`); this plan adds the missing HTTP surface, a new singleton `platform_controls` table holding a typed `agent_delivery_paused` boolean checked inside `advanceRun` (the single choke point for every run advance), audit-log entries for both admin actions, and a notification so the charity and funding corporation learn that a run was stopped.

**Tech Stack:** TypeScript, Next.js App Router route handlers, Drizzle ORM + Postgres, zod, vitest (unit + integration against real Postgres), pg-boss worker.

**Design spec:** `docs/superpowers/specs/2026-08-05-agent-run-kill-switch-design.md`

## Global Constraints

- **Halt semantics are between-steps, not instant.** Do NOT add cancellation, `AbortSignal`, or sandbox-id persistence. The `ModelProvider` and `SandboxRunner` seams are frozen in this slice.
- **The brake must not fail open.** If reading `platform_controls` throws, let the error propagate so the pg-boss job retries. Never `catch` it and default to "not paused".
- **Absent row means not paused.** `resetDb()` truncates every public table not matching `drizzle%`/`pgboss%` before every integration test (`src/test/db.ts:23-31`), so no singleton row is ever seeded. The reader defaults to `false`; the writer upserts.
- **Authoritative authz lives in the domain, not the route.** `requirePlatformAdmin()` only trusts the cookie's `isPlatformAdmin` claim (tech-debt M4, a 7-day cookie with no revocation). Every domain function must independently call `isPlatformAdmin(userId, tx)` against the database, exactly as `setRunStatus` already does.
- **API-only.** No admin UI, no new pages, no component changes.
- **Scopes are per-run and platform-wide only.** No per-workspace or per-org scope — agent runs create no workspace (US-11.2).
- **Follow house patterns exactly:** routes use `requirePlatformAdmin()` → domain call → `errorResponse(e)` with `readJson(req)` + a zod schema exported from the module (see `src/app/api/projects/[id]/compute-pledges/route.ts`). Table extras use the `(t) => ({ … })` object form (see `src/db/schema.ts:411-416`).
- **Full gate before every commit:** `npm run typecheck`, `npm run format:check`, `npm run lint`, `npm run test:coverage`, and integration tests with BOTH env vars set:
  ```bash
  TEST_DATABASE_URL=postgres://hodorhub:hodorhub@localhost:5432/hodorhub_test \
  DATABASE_URL=postgres://hodorhub:hodorhub@localhost:5432/hodorhub_test \
  npm run test:integration
  ```
  Requires `docker compose up -d db`. `npm run test:integration` alone fails with "TEST_DATABASE_URL … must be set".
- **Do not "fix" the argon2 require in the worker bundle.** `grep -c argon2 dist/worker.cjs` returning 1 is deliberate and documented at `src/worker/index.ts:4-9`.

## File Structure

| File | Responsibility |
|---|---|
| `src/db/schema.ts` (modify, after `auditLog` at :614) | `PLATFORM_CONTROLS_ID` constant + `platformControls` table |
| `drizzle/00NN_*.sql` (generated) | Migration creating the table |
| `src/db/platform-controls.integration.test.ts` (create) | Singleton constraint + default-state tests |
| `src/modules/agent-delivery/platform-controls.ts` (create) | Brake read/write domain + zod schema |
| `src/modules/agent-delivery/platform-controls.integration.test.ts` (create) | Brake domain tests |
| `src/test/agent-delivery-fixtures.ts` (create) | Shared integration fixtures — `twoOrgs()`, `authorisedRun()` |
| `src/modules/agent-delivery/dispatcher.ts` (modify) | Brake check in `advanceRun` |
| `src/modules/agent-delivery/dispatcher.test.ts` (create) | Fail-safe unit test (no DB) |
| `src/modules/agent-delivery/brake.integration.test.ts` (create) | Brake blocks/releases real runs |
| `src/modules/agent-delivery/service.ts` (modify) | `audit_log` write, enriched event payload, `runStatusSchema` |
| `src/modules/agent-delivery/index.ts` (modify) | Barrel exports |
| `src/modules/notifications/service.ts` (modify) | `RunStatusChanged` → notifications |
| `src/app/api/admin/runs/[id]/status/route.ts` (create) | Per-run control route |
| `src/app/api/admin/agent-delivery/brake/route.ts` (create) | Platform brake route |
| `src/app/api/agent-delivery.contract.integration.test.ts` (modify) | Route authz + status codes |
| `src/lib/e2b-sandbox-runner.test.ts` (modify) | Teardown regression test |
| `PRODUCT_BACKLOG.md`, `ARCHITECTURE.md` (modify) | Corrected US-11.5 wording + brake note |

---

### Task 1: `platform_controls` schema + migration

**Files:**
- Modify: `src/db/schema.ts` (insert after the `auditLog` table, which ends at line 614)
- Create: `src/db/platform-controls.integration.test.ts`
- Generated: `drizzle/00NN_<name>.sql`

**Interfaces:**
- Consumes: nothing.
- Produces: `PLATFORM_CONTROLS_ID: string` and the `platformControls` Drizzle table (columns `id`, `agentDeliveryPaused`, `updatedBy`, `updatedAt`), both exported from `@/db/schema`. Task 2 relies on both names.

- [ ] **Step 1: Write the failing test**

Create `src/db/platform-controls.integration.test.ts`:

```ts
import { describe, it, expect } from 'vitest';
import { testDb } from '@/test/db';
import { platformControls, PLATFORM_CONTROLS_ID } from '@/db/schema';

describe('platform_controls singleton table', () => {
  it('is empty after a reset — an absent row is the default state', async () => {
    const rows = await testDb.select().from(platformControls);
    expect(rows).toHaveLength(0);
  });

  it('accepts the fixed singleton id and defaults the brake to off', async () => {
    await testDb.insert(platformControls).values({ id: PLATFORM_CONTROLS_ID });
    const rows = await testDb.select().from(platformControls);
    expect(rows).toHaveLength(1);
    expect(rows[0]!.agentDeliveryPaused).toBe(false);
  });

  it('rejects any other id, so a second row can never exist', async () => {
    await expect(
      testDb.insert(platformControls).values({ id: '00000000-0000-0000-0000-000000000002' }),
    ).rejects.toThrow();
  });
});
```

- [ ] **Step 2: Run the test to verify it fails**

```bash
TEST_DATABASE_URL=postgres://hodorhub:hodorhub@localhost:5432/hodorhub_test \
DATABASE_URL=postgres://hodorhub:hodorhub@localhost:5432/hodorhub_test \
npm run test:integration -- src/db/platform-controls.integration.test.ts
```

Expected: FAIL — `platformControls` and `PLATFORM_CONTROLS_ID` are not exported from `@/db/schema`.

- [ ] **Step 3: Add the table to the schema**

In `src/db/schema.ts`, insert immediately after the `auditLog` table definition (ends line 614) and before the `// Outbox for the transactional-outbox event bus` comment:

```ts
// ── Platform controls (US-11.5) ──────────────────────────────────────────────
/**
 * The one and only platform_controls row. The CHECK below pins the primary key
 * to this uuid, so at most one row can ever exist.
 */
export const PLATFORM_CONTROLS_ID = '00000000-0000-0000-0000-000000000001';

/**
 * Platform-wide operational switches (US-11.5). Deliberately NOT seeded by the
 * migration: resetDb() truncates every app table between integration tests, so
 * an absent row is a normal state and means "the brake has never been pulled"
 * — readers default to false and writers upsert.
 */
export const platformControls = pgTable(
  'platform_controls',
  {
    id: uuid('id').primaryKey(),
    agentDeliveryPaused: boolean('agent_delivery_paused').notNull().default(false),
    updatedBy: uuid('updated_by').references(() => users.id),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => ({
    // The uuid is written as a literal, not interpolated from
    // PLATFORM_CONTROLS_ID: drizzle would bind a JS string as a query
    // parameter, which is invalid inside DDL. Keep the two in sync.
    singleton: check(
      'platform_controls_singleton',
      sql`${t.id} = '00000000-0000-0000-0000-000000000001'::uuid`,
    ),
  }),
);
```

`pgTable`, `uuid`, `boolean`, `timestamp`, `check`, and `sql` are all already imported at the top of the file (lines 1-14) — no import changes needed.

- [ ] **Step 4: Generate the migration**

```bash
npm run db:generate
```

This writes a new `drizzle/00NN_<random-name>.sql` (the next index after `0011_robust_puff_adder`; the generated name will differ from any example) and appends an entry to `drizzle/meta/_journal.json`.

- [ ] **Step 5: Verify the generated SQL is correct**

Read the new `drizzle/00NN_*.sql`. Confirm it contains `CREATE TABLE "platform_controls"` and a `CONSTRAINT "platform_controls_singleton" CHECK (...)` with the **literal uuid** in it — NOT a `$1` placeholder. It must contain no `INSERT`. If the CHECK shows a bound parameter, the `sql` template in Step 3 interpolated a JS value; fix it to an inline literal and regenerate.

- [ ] **Step 6: Run the test to verify it passes**

```bash
TEST_DATABASE_URL=postgres://hodorhub:hodorhub@localhost:5432/hodorhub_test \
DATABASE_URL=postgres://hodorhub:hodorhub@localhost:5432/hodorhub_test \
npm run test:integration -- src/db/platform-controls.integration.test.ts
```

Expected: PASS (3 tests). The integration global-setup applies the new migration automatically.

- [ ] **Step 7: Run the full gate, then commit**

```bash
npm run typecheck && npm run format:check && npm run lint
git add src/db/schema.ts src/db/platform-controls.integration.test.ts drizzle/
git commit -m "feat(agent-delivery): platform_controls singleton table (US-11.5)"
```

---

### Task 2: Brake domain module

**Files:**
- Create: `src/modules/agent-delivery/platform-controls.ts`
- Create: `src/modules/agent-delivery/platform-controls.integration.test.ts`
- Modify: `src/modules/agent-delivery/index.ts`

**Interfaces:**
- Consumes: `platformControls`, `PLATFORM_CONTROLS_ID` from `@/db/schema` (Task 1).
- Produces: `isAgentDeliveryPaused(db?): Promise<boolean>`, `setAgentDeliveryPaused(actingUserId: string, paused: boolean, db?): Promise<void>`, and `platformBrakeSchema` (zod, `{ paused: boolean }`) — all exported from `@/modules/agent-delivery`. Task 3 consumes `isAgentDeliveryPaused`; Task 6 consumes `setAgentDeliveryPaused` and `platformBrakeSchema`.

- [ ] **Step 1: Write the failing test**

Create `src/modules/agent-delivery/platform-controls.integration.test.ts`:

```ts
import { describe, it, expect } from 'vitest';
import { eq } from 'drizzle-orm';
import { testDb } from '@/test/db';
import { auditLog, outbox, platformControls } from '@/db/schema';
import { createPlatformAdmin, registerCharity, ForbiddenError } from '@/modules/identity';
import { isAgentDeliveryPaused, setAgentDeliveryPaused } from './platform-controls';

describe('agent-delivery platform brake', () => {
  it('reads as not paused when no row exists', async () => {
    expect(await isAgentDeliveryPaused(testDb)).toBe(false);
  });

  it('an admin pulls the brake, and it reads back as paused', async () => {
    const admin = await createPlatformAdmin('admin@hh.com', 'admin-password-1', testDb);
    await setAgentDeliveryPaused(admin, true, testDb);
    expect(await isAgentDeliveryPaused(testDb)).toBe(true);
  });

  it('an admin releases the brake again', async () => {
    const admin = await createPlatformAdmin('admin@hh.com', 'admin-password-1', testDb);
    await setAgentDeliveryPaused(admin, true, testDb);
    await setAgentDeliveryPaused(admin, false, testDb);
    expect(await isAgentDeliveryPaused(testDb)).toBe(false);
  });

  it('pulling the brake twice upserts rather than erroring, leaving one row', async () => {
    const admin = await createPlatformAdmin('admin@hh.com', 'admin-password-1', testDb);
    await setAgentDeliveryPaused(admin, true, testDb);
    await setAgentDeliveryPaused(admin, true, testDb);
    const rows = await testDb.select().from(platformControls);
    expect(rows).toHaveLength(1);
    expect(rows[0]!.updatedBy).toBe(admin);
  });

  it('refuses a non-admin', async () => {
    const charity = await registerCharity(
      {
        email: 'petra@goodcause.org',
        password: 'a-strong-password',
        charityName: 'Good Cause',
        regNumber: 'CH-1',
      },
      testDb,
    );
    await expect(setAgentDeliveryPaused(charity.userId, true, testDb)).rejects.toBeInstanceOf(
      ForbiddenError,
    );
    expect(await isAgentDeliveryPaused(testDb)).toBe(false);
  });

  it('writes an audit-log entry and an outbox event for each change', async () => {
    const admin = await createPlatformAdmin('admin@hh.com', 'admin-password-1', testDb);
    await setAgentDeliveryPaused(admin, true, testDb);

    const audits = await testDb
      .select()
      .from(auditLog)
      .where(eq(auditLog.action, 'agent_delivery.brake.pulled'));
    expect(audits).toHaveLength(1);
    expect(audits[0]!.actorId).toBe(admin);
    expect(audits[0]!.entity).toBe('platform_controls');

    const events = await testDb
      .select()
      .from(outbox)
      .where(eq(outbox.eventType, 'PlatformBrakeChanged'));
    expect(events).toHaveLength(1);
    expect((events[0]!.payload as Record<string, unknown>).agentDeliveryPaused).toBe(true);
  });
});
```

- [ ] **Step 2: Run the test to verify it fails**

```bash
TEST_DATABASE_URL=postgres://hodorhub:hodorhub@localhost:5432/hodorhub_test \
DATABASE_URL=postgres://hodorhub:hodorhub@localhost:5432/hodorhub_test \
npm run test:integration -- src/modules/agent-delivery/platform-controls.integration.test.ts
```

Expected: FAIL — cannot resolve `./platform-controls`.

- [ ] **Step 3: Write the implementation**

Create `src/modules/agent-delivery/platform-controls.ts`:

```ts
import { eq } from 'drizzle-orm';
import { z } from 'zod';
import { db as defaultDb } from '@/db';
import { platformControls, PLATFORM_CONTROLS_ID, auditLog, outbox } from '@/db/schema';
import { isPlatformAdmin, ForbiddenError } from '@/modules/identity';

type Db = typeof defaultDb;

/** Route body for the platform brake (US-11.5). */
export const platformBrakeSchema = z.object({ paused: z.boolean() });
export type PlatformBrakeInput = z.infer<typeof platformBrakeSchema>;

/**
 * US-11.5 — is the platform-wide agent-delivery brake engaged?
 *
 * An absent row means the brake has never been pulled → not paused. A thrown
 * read error is deliberately NOT swallowed: the caller must fail rather than
 * advance, so the brake can never fail open during exactly the database trouble
 * that might have prompted an operator to pull it.
 */
export async function isAgentDeliveryPaused(db: Db = defaultDb): Promise<boolean> {
  const row = await db.query.platformControls.findFirst({
    where: eq(platformControls.id, PLATFORM_CONTROLS_ID),
  });
  return row?.agentDeliveryPaused ?? false;
}

/**
 * US-11.5 — pull or release the platform-wide brake. Reversible by design: run
 * statuses are untouched, so every run resumes where it left off (via the
 * worker's reconciliation sweep, within RECONCILE_SWEEP_CRON) once released.
 *
 * Re-checks admin rights against the DATABASE rather than trusting the caller:
 * the route's requirePlatformAdmin() only reads the session cookie's claim
 * (tech-debt M4 — a 7-day cookie with no revocation).
 */
export async function setAgentDeliveryPaused(
  actingUserId: string,
  paused: boolean,
  db: Db = defaultDb,
): Promise<void> {
  await db.transaction(async (tx) => {
    if (!(await isPlatformAdmin(actingUserId, tx)))
      throw new ForbiddenError('Admin access required.');
    await tx
      .insert(platformControls)
      .values({ id: PLATFORM_CONTROLS_ID, agentDeliveryPaused: paused, updatedBy: actingUserId })
      .onConflictDoUpdate({
        target: platformControls.id,
        set: { agentDeliveryPaused: paused, updatedBy: actingUserId, updatedAt: new Date() },
      });
    await tx.insert(auditLog).values({
      actorId: actingUserId,
      action: paused ? 'agent_delivery.brake.pulled' : 'agent_delivery.brake.released',
      entity: 'platform_controls',
      entityId: null,
      metadata: { agentDeliveryPaused: paused },
    });
    await tx.insert(outbox).values({
      eventType: 'PlatformBrakeChanged',
      payload: { agentDeliveryPaused: paused, by: actingUserId },
    });
  });
}
```

- [ ] **Step 4: Export from the module barrel**

In `src/modules/agent-delivery/index.ts`, add after the existing `export { isRunActive, RUN_TERMINAL_STATUSES } from './run-status';` line:

```ts
export {
  isAgentDeliveryPaused,
  setAgentDeliveryPaused,
  platformBrakeSchema,
} from './platform-controls';
export type { PlatformBrakeInput } from './platform-controls';
```

- [ ] **Step 5: Run the test to verify it passes**

```bash
TEST_DATABASE_URL=postgres://hodorhub:hodorhub@localhost:5432/hodorhub_test \
DATABASE_URL=postgres://hodorhub:hodorhub@localhost:5432/hodorhub_test \
npm run test:integration -- src/modules/agent-delivery/platform-controls.integration.test.ts
```

Expected: PASS (6 tests).

- [ ] **Step 6: Run the full gate, then commit**

```bash
npm run typecheck && npm run format:check && npm run lint
git add src/modules/agent-delivery/platform-controls.ts src/modules/agent-delivery/platform-controls.integration.test.ts src/modules/agent-delivery/index.ts
git commit -m "feat(agent-delivery): platform-wide brake domain (US-11.5)"
```

---

### Task 3: Enforce the brake in `advanceRun`

**Files:**
- Create: `src/test/agent-delivery-fixtures.ts`
- Modify: `src/modules/agent-delivery/dispatcher.ts`
- Create: `src/modules/agent-delivery/dispatcher.test.ts`
- Create: `src/modules/agent-delivery/brake.integration.test.ts`

**Interfaces:**
- Consumes: `isAgentDeliveryPaused` from `./platform-controls` (Task 2).
- Produces: `twoOrgs()` and `authorisedRun()` from `@/test/agent-delivery-fixtures` — Tasks 4 and 5 import these instead of writing their own setup. `advanceRun`'s existing signature and `{ ran, status, phase }` return shape are unchanged; no new module exports.

- [ ] **Step 1: Create the shared integration fixtures**

Several US-11.5 suites need the same starting points, so they live in one place rather than being copy-pasted per file. Create `src/test/agent-delivery-fixtures.ts`:

```ts
import { testDb } from './db';
import { fundComputeBudget, acceptComputePledge } from '@/modules/commitments';
import {
  registerCharity,
  registerCorporation,
  approveVerification,
  createPlatformAdmin,
} from '@/modules/identity';
import { createDraftProject, setResourceNeeds, publishProject } from '@/modules/projects';

/**
 * Shared agent-delivery integration fixtures (US-11.5). Several suites need the
 * same "two verified orgs" and "one authorised run" starting points; keeping
 * them here avoids a copy of this setup in every test file.
 */
export async function twoOrgs() {
  const admin = await createPlatformAdmin('admin@hh.com', 'admin-password-1', testDb);
  const charity = await registerCharity(
    {
      email: 'petra@goodcause.org',
      password: 'a-strong-password',
      charityName: 'Good Cause',
      regNumber: 'CH-1',
    },
    testDb,
  );
  const corp = await registerCorporation(
    {
      email: 'carlos@acme.com',
      password: 'a-strong-password',
      companyName: 'Acme',
      emailDomain: 'acme.com',
    },
    testDb,
  );
  await approveVerification(charity.verificationRequestId, admin, testDb);
  await approveVerification(corp.verificationRequestId, admin, testDb);
  return { admin, charity, corp };
}

/** Two verified orgs → published project → funded pledge → accepted = one authorised run. */
export async function authorisedRun() {
  const { admin, charity, corp } = await twoOrgs();
  const project = await createDraftProject(
    charity.userId,
    {
      charityOrgId: charity.organisationId,
      title: 'Portal',
      description: 'A worthy cause that needs a hand.',
      goal: 'Reach the finish line.',
      category: 'software',
    },
    testDb,
  );
  await setResourceNeeds(
    charity.userId,
    project.projectId,
    [
      {
        skill: 'Backend',
        role: 'Dev',
        kind: 'ongoing',
        quantity: 1,
        hoursPerWeek: 2,
        durationWeeks: 8,
      },
    ],
    testDb,
  );
  await publishProject(charity.userId, project.projectId, testDb);
  const { computePledgeId } = await fundComputeBudget(
    corp.userId,
    project.projectId,
    { corporationOrgId: corp.organisationId, templateCode: 'static-site', budgetMinor: 50000 },
    testDb,
  );
  const { runId } = await acceptComputePledge(charity.userId, computePledgeId, testDb);
  return { admin, charity, corp, projectId: project.projectId, runId };
}
```

- [ ] **Step 2: Write the failing integration test**

Create `src/modules/agent-delivery/brake.integration.test.ts`:

```ts
import { describe, it, expect } from 'vitest';
import { eq } from 'drizzle-orm';
import { testDb } from '@/test/db';
import { runMilestones } from '@/db/schema';
import { FakeModelProvider } from '@/lib/fake-model-provider';
import { authorisedRun } from '@/test/agent-delivery-fixtures';
import { advanceRun } from './dispatcher';
import { setAgentDeliveryPaused } from './platform-controls';

describe('platform brake blocks every run advance', () => {
  it('does not advance a runnable run while the brake is engaged', async () => {
    const { admin, runId } = await authorisedRun();
    await setAgentDeliveryPaused(admin, true, testDb);

    const provider = new FakeModelProvider([{ text: 'criteria' }]);
    const result = await advanceRun(runId, provider, testDb);

    expect(result.ran).toBe(false);
    expect(result.status).toBe('authorized');
    expect(result.phase).toBe('requirements');
    const milestones = await testDb
      .select()
      .from(runMilestones)
      .where(eq(runMilestones.runId, runId));
    expect(milestones).toHaveLength(0);
  });

  it('advances again once the brake is released', async () => {
    const { admin, runId } = await authorisedRun();
    await setAgentDeliveryPaused(admin, true, testDb);
    const provider = new FakeModelProvider([{ text: 'criteria' }]);
    await advanceRun(runId, provider, testDb);

    await setAgentDeliveryPaused(admin, false, testDb);
    const result = await advanceRun(runId, provider, testDb);

    expect(result.ran).toBe(true);
    expect(result.status).toBe('awaiting_gate');
    const milestones = await testDb
      .select()
      .from(runMilestones)
      .where(eq(runMilestones.runId, runId));
    expect(milestones).toHaveLength(1);
  });
});
```

- [ ] **Step 3: Write the failing fail-safe unit test**

Create `src/modules/agent-delivery/dispatcher.test.ts`:

```ts
import { describe, it, expect } from 'vitest';
import { FakeModelProvider } from '@/lib/fake-model-provider';
import { advanceRun } from './dispatcher';

/**
 * The brake must never fail open: if the platform_controls read throws, the
 * advance must fail (the pg-boss job then retries) rather than proceed as if
 * the brake were off. No database needed — a stub executor is enough.
 */
describe('advanceRun brake fail-safe', () => {
  it('propagates a platform_controls read error instead of advancing', async () => {
    const stubDb = {
      query: {
        agentDeliveryRuns: {
          findFirst: async () => ({
            id: 'run-1',
            status: 'authorized',
            currentPhase: 'requirements',
          }),
        },
        platformControls: {
          findFirst: async () => {
            throw new Error('platform_controls unavailable');
          },
        },
      },
    } as unknown as Parameters<typeof advanceRun>[2];

    await expect(
      advanceRun('run-1', new FakeModelProvider([{ text: 'criteria' }]), stubDb),
    ).rejects.toThrow('platform_controls unavailable');
  });
});
```

- [ ] **Step 4: Run both tests to verify they fail**

```bash
npm run test -- src/modules/agent-delivery/dispatcher.test.ts
TEST_DATABASE_URL=postgres://hodorhub:hodorhub@localhost:5432/hodorhub_test \
DATABASE_URL=postgres://hodorhub:hodorhub@localhost:5432/hodorhub_test \
npm run test:integration -- src/modules/agent-delivery/brake.integration.test.ts
```

Expected: both FAIL — `advanceRun` currently ignores the brake, so the run advances (integration) and no `platform_controls` read happens (unit).

- [ ] **Step 5: Add the brake check**

In `src/modules/agent-delivery/dispatcher.ts`, add the import beneath the existing `import { advanceRun }`-adjacent imports (after `import { runDeliveryPhase } from './delivery';`):

```ts
import { isAgentDeliveryPaused } from './platform-controls';
```

Then, inside `advanceRun`, insert immediately after `if (!run) throw new NotFoundError('Run');` and before the `const runnableStatus = …` line:

```ts
  // US-11.5 — platform-wide brake. Checked here because advanceRun is the
  // single choke point for both the relay-driven enqueue and the reconciliation
  // sweep, so one check covers every path. A thrown read error propagates
  // (fail-safe): the pg-boss job retries rather than advancing.
  if (await isAgentDeliveryPaused(db)) {
    return { ran: false, status: run.status, phase: run.currentPhase };
  }
```

Also extend the function's doc comment: after the existing sentence about non-runnable statuses being a no-op, add `Any advance is also a no-op while the platform-wide brake is engaged (US-11.5).`

- [ ] **Step 6: Run both tests to verify they pass**

```bash
npm run test -- src/modules/agent-delivery/dispatcher.test.ts
TEST_DATABASE_URL=postgres://hodorhub:hodorhub@localhost:5432/hodorhub_test \
DATABASE_URL=postgres://hodorhub:hodorhub@localhost:5432/hodorhub_test \
npm run test:integration -- src/modules/agent-delivery/brake.integration.test.ts
```

Expected: PASS (1 unit test, 2 integration tests).

- [ ] **Step 7: Run the full gate, then commit**

```bash
npm run typecheck && npm run format:check && npm run lint && npm run test:coverage
TEST_DATABASE_URL=postgres://hodorhub:hodorhub@localhost:5432/hodorhub_test \
DATABASE_URL=postgres://hodorhub:hodorhub@localhost:5432/hodorhub_test \
npm run test:integration
npm run build:workers
git add src/test/agent-delivery-fixtures.ts src/modules/agent-delivery/dispatcher.ts src/modules/agent-delivery/dispatcher.test.ts src/modules/agent-delivery/brake.integration.test.ts
git commit -m "feat(agent-delivery): enforce the platform brake in advanceRun (US-11.5)"
```

The full integration suite matters here: this change sits on the path every existing agent-delivery test uses.

---

### Task 4: Audit log, enriched event payload, and the route schema for `setRunStatus`

**Files:**
- Modify: `src/modules/agent-delivery/service.ts` (imports at :1-13; `setRunStatus` at :191-218)
- Modify: `src/modules/agent-delivery/index.ts`
- Create: `src/modules/agent-delivery/run-status-admin.integration.test.ts`

**Interfaces:**
- Consumes: the existing `setRunStatus(actingUserId, runId, status, db?)`; `authorisedRun()` from `@/test/agent-delivery-fixtures` (Task 3), which returns `{ admin, charity, corp, projectId, runId }`.
- Produces: `runStatusSchema` (zod, `{ status: 'paused' | 'running' | 'halted' }`) exported from `@/modules/agent-delivery` — Task 6 consumes it. The `RunStatusChanged` outbox payload gains `charityOrgId` and `corporationOrgId` — Task 5 consumes both.

- [ ] **Step 1: Write the failing test**

Create `src/modules/agent-delivery/run-status-admin.integration.test.ts`:

```ts
import { describe, it, expect } from 'vitest';
import { eq } from 'drizzle-orm';
import { testDb } from '@/test/db';
import { auditLog, outbox } from '@/db/schema';
import { ForbiddenError } from '@/modules/identity';
import { authorisedRun } from '@/test/agent-delivery-fixtures';
import { setRunStatus, runStatusSchema } from '.';

describe('setRunStatus admin audit + event payload', () => {
  it('writes an audit-log entry naming the actor and the transition', async () => {
    const { admin, runId } = await authorisedRun();
    await setRunStatus(admin, runId, 'paused', testDb);

    const audits = await testDb
      .select()
      .from(auditLog)
      .where(eq(auditLog.action, 'agent_delivery.run.paused'));
    expect(audits).toHaveLength(1);
    expect(audits[0]!.actorId).toBe(admin);
    expect(audits[0]!.entity).toBe('agent_delivery_run');
    expect(audits[0]!.entityId).toBe(runId);
    expect((audits[0]!.metadata as Record<string, unknown>).previousStatus).toBe('authorized');
  });

  it('emits RunStatusChanged carrying both parties so notifications can route', async () => {
    const { admin, charity, corp, runId } = await authorisedRun();
    await setRunStatus(admin, runId, 'paused', testDb);

    const events = await testDb
      .select()
      .from(outbox)
      .where(eq(outbox.eventType, 'RunStatusChanged'));
    expect(events).toHaveLength(1);
    const payload = events[0]!.payload as Record<string, unknown>;
    expect(payload.runId).toBe(runId);
    expect(payload.status).toBe('paused');
    expect(payload.charityOrgId).toBe(charity.organisationId);
    expect(payload.corporationOrgId).toBe(corp.organisationId);
  });

  it('refuses a non-admin without writing an audit entry', async () => {
    const { charity, runId } = await authorisedRun();
    await expect(setRunStatus(charity.userId, runId, 'halted', testDb)).rejects.toBeInstanceOf(
      ForbiddenError,
    );
    const audits = await testDb.select().from(auditLog);
    expect(audits).toHaveLength(0);
  });

  it('accepts only the three admin-settable statuses', () => {
    expect(runStatusSchema.parse({ status: 'paused' }).status).toBe('paused');
    expect(runStatusSchema.parse({ status: 'running' }).status).toBe('running');
    expect(runStatusSchema.parse({ status: 'halted' }).status).toBe('halted');
    expect(() => runStatusSchema.parse({ status: 'completed' })).toThrow();
    expect(() => runStatusSchema.parse({})).toThrow();
  });
});
```

- [ ] **Step 2: Run the test to verify it fails**

```bash
TEST_DATABASE_URL=postgres://hodorhub:hodorhub@localhost:5432/hodorhub_test \
DATABASE_URL=postgres://hodorhub:hodorhub@localhost:5432/hodorhub_test \
npm run test:integration -- src/modules/agent-delivery/run-status-admin.integration.test.ts
```

Expected: FAIL — `runStatusSchema` is not exported, no audit row is written, and the payload lacks the org ids.

- [ ] **Step 3: Update the imports in `service.ts`**

In `src/modules/agent-delivery/service.ts`, change line 1 and line 3 to add `z` and `auditLog`:

```ts
import { eq } from 'drizzle-orm';
import { z } from 'zod';
import { db as defaultDb } from '@/db';
import { agentDeliveryRuns, runBudgets, runMilestones, outbox, auditLog } from '@/db/schema';
```

- [ ] **Step 4: Add the zod schema**

In `src/modules/agent-delivery/service.ts`, immediately above the `/** US-11.5 — platform admin kill switch: pause/halt/resume a run. */` comment at line 190:

```ts
/** Route body for the per-run admin control (US-11.5). */
export const runStatusSchema = z.object({
  status: z.enum(['paused', 'running', 'halted']),
});
export type RunStatusInput = z.infer<typeof runStatusSchema>;
```

- [ ] **Step 5: Write the audit entry and enrich the event**

In `setRunStatus`, replace the existing status-update-and-emit block (the `await tx.update(agentDeliveryRuns)…` through the `RunStatusChanged` insert, lines 207-213) with:

```ts
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
```

- [ ] **Step 6: Export the schema from the barrel**

In `src/modules/agent-delivery/index.ts`, add `runStatusSchema` to the existing `export { … } from './service';` block (the one already listing `setRunStatus`), and add below it:

```ts
export type { RunStatusInput } from './service';
```

- [ ] **Step 7: Run the test to verify it passes**

```bash
TEST_DATABASE_URL=postgres://hodorhub:hodorhub@localhost:5432/hodorhub_test \
DATABASE_URL=postgres://hodorhub:hodorhub@localhost:5432/hodorhub_test \
npm run test:integration -- src/modules/agent-delivery/run-status-admin.integration.test.ts
```

Expected: PASS (4 tests).

- [ ] **Step 8: Run the full gate, then commit**

```bash
npm run typecheck && npm run format:check && npm run lint && npm run test:coverage
TEST_DATABASE_URL=postgres://hodorhub:hodorhub@localhost:5432/hodorhub_test \
DATABASE_URL=postgres://hodorhub:hodorhub@localhost:5432/hodorhub_test \
npm run test:integration
git add src/modules/agent-delivery/service.ts src/modules/agent-delivery/index.ts src/modules/agent-delivery/run-status-admin.integration.test.ts
git commit -m "feat(agent-delivery): audit log + party ids on RunStatusChanged (US-11.5, US-11.10)"
```

Run the whole integration suite: `run-closed.integration.test.ts` and `merit-integrity.integration.test.ts` both already exercise `setRunStatus` and must stay green.

---

### Task 5: Notify both parties when a run is paused, resumed, or halted

**Files:**
- Modify: `src/modules/notifications/service.ts` (the `dispatchEvent` switch; add a case before `default:` at line 145)
- Create: `src/modules/notifications/run-status-notification.integration.test.ts`

**Interfaces:**
- Consumes: the `RunStatusChanged` payload shape from Task 4 — `{ runId, status, by, charityOrgId, corporationOrgId }`; `twoOrgs()` from `@/test/agent-delivery-fixtures` (Task 3), which returns `{ admin, charity, corp }`.
- Produces: no new exports. Notification `type` values `agent_run.paused`, `agent_run.resumed`, `agent_run.halted`.

**Note on scope:** this closes the US-11.5 AC "the parties are notified" for the admin control only. `RunClosed`, `ComputePledgeAccepted`, `MilestoneApproved`, `MilestoneChangesRequested`, and `MilestoneRejected` still produce no notification — a pre-existing Epic 11 gap, deliberately left for its own story. Do not widen this task to cover them.

- [ ] **Step 1: Write the failing test**

Create `src/modules/notifications/run-status-notification.integration.test.ts`:

```ts
import { describe, it, expect } from 'vitest';
import { eq } from 'drizzle-orm';
import { testDb } from '@/test/db';
import { notifications } from '@/db/schema';
import { twoOrgs } from '@/test/agent-delivery-fixtures';
import { dispatchEvent } from './service';

describe('RunStatusChanged notifications', () => {
  it('notifies the charity owner and the CSR manager when a run is halted', async () => {
    const { charity, corp } = await twoOrgs();
    await dispatchEvent(testDb, {
      eventType: 'RunStatusChanged',
      payload: {
        runId: 'run-1',
        status: 'halted',
        by: 'admin-1',
        charityOrgId: charity.organisationId,
        corporationOrgId: corp.organisationId,
      },
    });

    const rows = await testDb
      .select()
      .from(notifications)
      .where(eq(notifications.type, 'agent_run.halted'));
    expect(rows).toHaveLength(2);
    expect(rows.map((r) => r.userId).sort()).toEqual([charity.userId, corp.userId].sort());
  });

  it('uses a distinct type for paused and resumed', async () => {
    const { charity, corp } = await twoOrgs();
    const base = {
      runId: 'run-1',
      by: 'admin-1',
      charityOrgId: charity.organisationId,
      corporationOrgId: corp.organisationId,
    };
    await dispatchEvent(testDb, {
      eventType: 'RunStatusChanged',
      payload: { ...base, status: 'paused' },
    });
    await dispatchEvent(testDb, {
      eventType: 'RunStatusChanged',
      payload: { ...base, status: 'running' },
    });

    const paused = await testDb
      .select()
      .from(notifications)
      .where(eq(notifications.type, 'agent_run.paused'));
    const resumed = await testDb
      .select()
      .from(notifications)
      .where(eq(notifications.type, 'agent_run.resumed'));
    expect(paused).toHaveLength(2);
    expect(resumed).toHaveLength(2);
  });
});
```

- [ ] **Step 2: Run the test to verify it fails**

```bash
TEST_DATABASE_URL=postgres://hodorhub:hodorhub@localhost:5432/hodorhub_test \
DATABASE_URL=postgres://hodorhub:hodorhub@localhost:5432/hodorhub_test \
npm run test:integration -- src/modules/notifications/run-status-notification.integration.test.ts
```

Expected: FAIL — `RunStatusChanged` currently falls through to `default: break`, so zero notifications are written.

- [ ] **Step 3: Add the case**

In `src/modules/notifications/service.ts`, insert immediately before the `default:` arm (line 145):

```ts
    case 'RunStatusChanged': {
      // US-11.5 — an admin paused, resumed, or halted an agent-delivery run;
      // both parties are told. Org ids ride on the event payload so this
      // consumer need not read the AgentDelivery tables.
      const status = p.status as string;
      const type =
        status === 'paused'
          ? 'agent_run.paused'
          : status === 'running'
            ? 'agent_run.resumed'
            : 'agent_run.halted';
      const owner = await orgMember(exec, p.charityOrgId as string, 'charity_owner');
      const csr = await orgMember(exec, p.corporationOrgId as string, 'csr_manager');
      await create(exec, owner, type, p);
      await create(exec, csr, type, p);
      break;
    }
```

Then update the `default:` comment on the following line so it no longer implies agent-delivery events are all unhandled — change it to:

```ts
    default:
      break; // ProjectPublished, ProjectStatusChanged, ProjectSupported, ResourceGiftWithdrawn, RunClosed, MilestoneApproved, etc. → no notification
```

- [ ] **Step 4: Run the test to verify it passes**

```bash
TEST_DATABASE_URL=postgres://hodorhub:hodorhub@localhost:5432/hodorhub_test \
DATABASE_URL=postgres://hodorhub:hodorhub@localhost:5432/hodorhub_test \
npm run test:integration -- src/modules/notifications/run-status-notification.integration.test.ts
```

Expected: PASS (2 tests).

- [ ] **Step 5: Run the full gate, then commit**

```bash
npm run typecheck && npm run format:check && npm run lint && npm run test:coverage
TEST_DATABASE_URL=postgres://hodorhub:hodorhub@localhost:5432/hodorhub_test \
DATABASE_URL=postgres://hodorhub:hodorhub@localhost:5432/hodorhub_test \
npm run test:integration
npm run build:workers
grep -c argon2 dist/worker.cjs
git add src/modules/notifications/service.ts src/modules/notifications/run-status-notification.integration.test.ts
git commit -m "feat(notifications): tell both parties when an admin stops a run (US-11.5)"
```

`build:workers` matters here — Notifications is in the worker bundle. Expect `grep -c argon2` to print `1`; that is the documented, deliberate state (see Global Constraints), not a regression.

---

### Task 6: The two admin HTTP routes

**Files:**
- Create: `src/app/api/admin/runs/[id]/status/route.ts`
- Create: `src/app/api/admin/agent-delivery/brake/route.ts`
- Modify: `src/app/api/agent-delivery.contract.integration.test.ts`

**Interfaces:**
- Consumes: `setRunStatus`, `runStatusSchema`, `setAgentDeliveryPaused`, `platformBrakeSchema` from `@/modules/agent-delivery` (Tasks 2 and 4); `requirePlatformAdmin` from `@/lib/auth`; `errorResponse`, `readJson` from `@/lib/http`.
- Produces: two `POST` handlers. `POST /api/admin/runs/[id]/status` returns `{ ok: true, status }`; `POST /api/admin/agent-delivery/brake` returns `{ ok: true, agentDeliveryPaused }`.

- [ ] **Step 1: Write the failing tests**

In `src/app/api/agent-delivery.contract.integration.test.ts`, add these two imports beside the existing route imports (after `import { POST as approveRoute } from './agent-milestones/[id]/approve/route';`):

```ts
import { POST as runStatusRoute } from './admin/runs/[id]/status/route';
import { POST as brakeRoute } from './admin/agent-delivery/brake/route';
```

Then append this describe block at the end of the file:

```ts
/**
 * The file's fundedPublishedProject() publishes a project but does NOT fund it
 * and returns no runId, so drive fund → accept through the routes to get one,
 * exactly as the accept-route test above does. Do not modify that helper.
 */
async function runViaRoutes() {
  const { admin, charity, corp, projectId } = await fundedPublishedProject();
  authAs(corp.userId);
  const fundRes = await fundRoute(
    jsonReq({
      corporationOrgId: corp.organisationId,
      templateCode: 'static-site',
      budgetMinor: 5000,
    }),
    params(projectId),
  );
  const { computePledgeId } = await fundRes.json();
  authAs(charity.userId);
  const acceptRes = await acceptPledgeRoute(jsonReq({}), params(computePledgeId));
  const { runId } = await acceptRes.json();
  return { admin, charity, corp, runId };
}

describe('admin run controls (US-11.5)', () => {
  it('lets a platform admin pause a run', async () => {
    const { runId, admin } = await runViaRoutes();
    authAs(admin, true);
    const res = await runStatusRoute(jsonReq({ status: 'paused' }), params(runId));
    expect(res.status).toBe(200);
    await expect(res.json()).resolves.toMatchObject({ ok: true, status: 'paused' });
  });

  it('refuses a non-admin with 403', async () => {
    const { runId, charity } = await runViaRoutes();
    authAs(charity.userId);
    const res = await runStatusRoute(jsonReq({ status: 'halted' }), params(runId));
    expect(res.status).toBe(403);
  });

  it('rejects a status outside the admin-settable set with 400', async () => {
    const { runId, admin } = await runViaRoutes();
    authAs(admin, true);
    const res = await runStatusRoute(jsonReq({ status: 'completed' }), params(runId));
    expect(res.status).toBe(400);
  });

  it('returns 409 when the run is already terminal', async () => {
    const { runId, admin } = await runViaRoutes();
    authAs(admin, true);
    await runStatusRoute(jsonReq({ status: 'halted' }), params(runId));
    const res = await runStatusRoute(jsonReq({ status: 'paused' }), params(runId));
    expect(res.status).toBe(409);
  });

  it('returns 404 for an unknown run', async () => {
    const { admin } = await runViaRoutes();
    authAs(admin, true);
    const res = await runStatusRoute(
      jsonReq({ status: 'paused' }),
      params('11111111-1111-1111-1111-111111111111'),
    );
    expect(res.status).toBe(404);
  });

  it('lets a platform admin pull and release the platform brake', async () => {
    const { admin } = await runViaRoutes();
    authAs(admin, true);
    const on = await brakeRoute(jsonReq({ paused: true }));
    expect(on.status).toBe(200);
    await expect(on.json()).resolves.toMatchObject({ ok: true, agentDeliveryPaused: true });
    const off = await brakeRoute(jsonReq({ paused: false }));
    expect(off.status).toBe(200);
    await expect(off.json()).resolves.toMatchObject({ agentDeliveryPaused: false });
  });

  it('refuses the platform brake to a non-admin with 403', async () => {
    const { charity } = await runViaRoutes();
    authAs(charity.userId);
    const res = await brakeRoute(jsonReq({ paused: true }));
    expect(res.status).toBe(403);
  });

  it('rejects a malformed brake body with 400', async () => {
    const { admin } = await runViaRoutes();
    authAs(admin, true);
    const res = await brakeRoute(jsonReq({ paused: 'yes' }));
    expect(res.status).toBe(400);
  });
});
```

Note `authAs(admin, true)`: `createPlatformAdmin` returns the user id as a plain string (not an object), and the second argument sets the session's `isPlatformAdmin` claim. `charity.userId` and `corp.userId` are properties because `registerCharity`/`registerCorporation` return objects.

- [ ] **Step 2: Run the tests to verify they fail**

```bash
TEST_DATABASE_URL=postgres://hodorhub:hodorhub@localhost:5432/hodorhub_test \
DATABASE_URL=postgres://hodorhub:hodorhub@localhost:5432/hodorhub_test \
npm run test:integration -- src/app/api/agent-delivery.contract.integration.test.ts
```

Expected: FAIL — neither route module exists.

- [ ] **Step 3: Write the per-run route**

Create `src/app/api/admin/runs/[id]/status/route.ts`:

```ts
import { NextResponse } from 'next/server';
import { setRunStatus, runStatusSchema } from '@/modules/agent-delivery';
import { requirePlatformAdmin } from '@/lib/auth';
import { errorResponse, readJson } from '@/lib/http';

// US-11.5 — a platform admin pauses, resumes, or halts one agent-delivery run.
// setRunStatus re-checks admin rights against the database; this gate only
// filters on the session claim (tech-debt M4).
export async function POST(req: Request, { params }: { params: Promise<{ id: string }> }) {
  try {
    const admin = await requirePlatformAdmin();
    const { id } = await params;
    const { status } = runStatusSchema.parse(await readJson(req));
    await setRunStatus(admin.userId, id, status);
    return NextResponse.json({ ok: true, status });
  } catch (e) {
    return errorResponse(e);
  }
}
```

- [ ] **Step 4: Write the platform brake route**

Create `src/app/api/admin/agent-delivery/brake/route.ts`:

```ts
import { NextResponse } from 'next/server';
import { setAgentDeliveryPaused, platformBrakeSchema } from '@/modules/agent-delivery';
import { requirePlatformAdmin } from '@/lib/auth';
import { errorResponse, readJson } from '@/lib/http';

// US-11.5 — reversible platform-wide brake: stops every agent-delivery run at
// its next step boundary without touching run statuses. Releasing it lets runs
// resume via the worker's reconciliation sweep.
export async function POST(req: Request) {
  try {
    const admin = await requirePlatformAdmin();
    const { paused } = platformBrakeSchema.parse(await readJson(req));
    await setAgentDeliveryPaused(admin.userId, paused);
    return NextResponse.json({ ok: true, agentDeliveryPaused: paused });
  } catch (e) {
    return errorResponse(e);
  }
}
```

- [ ] **Step 5: Run the tests to verify they pass**

```bash
TEST_DATABASE_URL=postgres://hodorhub:hodorhub@localhost:5432/hodorhub_test \
DATABASE_URL=postgres://hodorhub:hodorhub@localhost:5432/hodorhub_test \
npm run test:integration -- src/app/api/agent-delivery.contract.integration.test.ts
```

Expected: PASS, including the pre-existing tests in that file.

- [ ] **Step 6: Run the full gate, then commit**

```bash
npm run typecheck && npm run format:check && npm run lint && npm run test:coverage
TEST_DATABASE_URL=postgres://hodorhub:hodorhub@localhost:5432/hodorhub_test \
DATABASE_URL=postgres://hodorhub:hodorhub@localhost:5432/hodorhub_test \
npm run test:integration
npm run build
git add "src/app/api/admin/runs/[id]/status/route.ts" src/app/api/admin/agent-delivery/brake/route.ts src/app/api/agent-delivery.contract.integration.test.ts
git commit -m "feat(api): admin run-control and platform-brake routes (US-11.5)"
```

`npm run build` matters here: it is the check that both new route handlers compile as App Router routes.

---

### Task 7: Sandbox-teardown regression test and documentation

**Files:**
- Modify: `src/lib/e2b-sandbox-runner.test.ts`
- Modify: `PRODUCT_BACKLOG.md` (US-11.5 section)
- Modify: `ARCHITECTURE.md`

**Interfaces:**
- Consumes: the existing `fakeSandbox()` helper and `baseReq` constant at the top of `e2b-sandbox-runner.test.ts`.
- Produces: nothing consumed by other tasks.

- [ ] **Step 1: Write the failing-if-regressed test**

In `src/lib/e2b-sandbox-runner.test.ts`, append inside the existing `describe('E2bSandboxRunner', …)` block:

```ts
  it('kills the sandbox even when the build command throws (US-11.5/11.6 teardown)', async () => {
    const f = fakeSandbox({ exitCode: 0, tarball: new TextEncoder().encode('BUILD') });
    f.sbx.runCommand = async () => {
      throw new Error('sandbox exploded');
    };
    const runner = new E2bSandboxRunner({
      artifactStore: new InMemoryArtifactStore(),
      sandboxFactory: async () => f.sbx,
    });

    await expect(runner.runBuild(baseReq)).rejects.toThrow('sandbox exploded');
    expect(f.killed).toBe(true);
  });
```

This pins the property that makes the story's "the sandbox is torn down" AC already true: no sandbox outlives a single `runBuild` call, because `kill()` is in a `finally`. It passes on the current code and fails if anyone removes that `finally`.

- [ ] **Step 2: Run the test to verify it passes**

```bash
npm run test -- src/lib/e2b-sandbox-runner.test.ts
```

Expected: PASS. If it FAILS, the `finally` in `runBuild` is gone — restore it rather than adjusting the test.

- [ ] **Step 3: Correct the US-11.5 story text**

In `PRODUCT_BACKLOG.md`, replace this line:

```markdown
**As a** Platform Admin, **I want** to pause or stop agent-delivery runs — per run, per workspace, or platform-wide — **so that** I can intervene instantly if something goes wrong.
```

with:

```markdown
**As a** Platform Admin, **I want** to pause or stop agent-delivery runs — per run or platform-wide — **so that** I can intervene quickly if something goes wrong.
```

Then, directly beneath the existing `- **Given** a running run, …` acceptance criterion, add:

```markdown
- ✅ **Resolved (2026-08-05).** "Per workspace" does not apply to this path: an agent-delivery run creates no delivery workspace (US-11.2) — that belongs to human donated-time delivery (US-5.3, US-6.x). Scopes built: **per run** and **platform-wide**. The platform-wide control is a *reversible brake* (runs stop at their next step boundary with statuses untouched, and resume when released), not a mass halt. "Halt between steps" is the contract — an in-flight model call or build runs to completion first; interrupting in-flight work was considered and rejected (it would require changing the frozen ModelProvider/SandboxRunner seams). Sandbox teardown was already structurally guaranteed. Design: `docs/superpowers/specs/2026-08-05-agent-run-kill-switch-design.md`.
```

- [ ] **Step 4: Document the brake in ARCHITECTURE.md**

Find the section describing the AgentDelivery bounded context. Add one line to it:

```markdown
- **Platform brake (US-11.5).** `platform_controls` is a singleton table holding `agent_delivery_paused`, checked in `advanceRun` — the single choke point for every run advance, so one check covers both the relay-driven enqueue and the reconciliation sweep. It is reversible and never fails open: a read error propagates so the worker job retries rather than advancing. An absent row means "never pulled". Per-run control is `setRunStatus` (`paused` is resumable; `halted` is terminal).
```

- [ ] **Step 5: Run the full gate, then commit**

```bash
npm run typecheck && npm run format:check && npm run lint && npm run test:coverage
TEST_DATABASE_URL=postgres://hodorhub:hodorhub@localhost:5432/hodorhub_test \
DATABASE_URL=postgres://hodorhub:hodorhub@localhost:5432/hodorhub_test \
npm run test:integration
npm run build:workers && npm run build
git add src/lib/e2b-sandbox-runner.test.ts PRODUCT_BACKLOG.md ARCHITECTURE.md
git commit -m "test(agent-delivery): pin sandbox teardown; docs: correct US-11.5 scope"
```

---

## Verify it in the running app

After Task 7, drive the real app — tests alone have not proven the routes work end to end.

- [ ] **Step 1: Start everything**

```bash
docker compose up -d
DATABASE_URL=postgres://hodorhub:hodorhub@localhost:5432/hodorhub npm run db:migrate
npm run db:seed
npm run dev          # background; wait for "Ready in"
npx tsx --env-file=.env.local src/worker/index.ts   # background
```

- [ ] **Step 2: Sign in as the seeded platform admin**

```bash
curl -s -c admin.txt -X POST http://localhost:3000/api/auth/login \
  -H 'content-type: application/json' \
  -d '{"email":"admin@hodorhub.test","password":"Password123!"}'
```

Expected: `{"ok":true,"isPlatformAdmin":true}`.

- [ ] **Step 3: Pull the platform brake, then fund and accept a run**

```bash
curl -s -b admin.txt -X POST http://localhost:3000/api/admin/agent-delivery/brake \
  -H 'content-type: application/json' -d '{"paused":true}'
```

Expected: `{"ok":true,"agentDeliveryPaused":true}`. Now sign in as `corp@hodorhub.test`, fund agent delivery on a published project, accept it as `charity@hodorhub.test`, and watch the worker log: `agent.advance <runId> requirements authorized false` — `ran` is **false** and the run does not leave `authorized`.

- [ ] **Step 4: Release the brake and confirm the run advances**

```bash
curl -s -b admin.txt -X POST http://localhost:3000/api/admin/agent-delivery/brake \
  -H 'content-type: application/json' -d '{"paused":false}'
```

Within one reconciliation sweep (≤5 minutes, `*/5 * * * *`) the worker logs an advance and the run reaches `awaiting_gate`. Confirm the project page's run panel shows the requirements milestone.

- [ ] **Step 5: Halt that run per-run and confirm both parties are notified**

```bash
curl -s -b admin.txt -X POST http://localhost:3000/api/admin/runs/<runId>/status \
  -H 'content-type: application/json' -d '{"status":"halted"}'
```

Expected `{"ok":true,"status":"halted"}`. Then sign in as `charity@hodorhub.test` and `corp@hodorhub.test` and check `GET /notifications` — each should show an `agent_run.halted` entry. Re-POST `{"status":"paused"}` and expect **409**.

- [ ] **Step 6: Record the outcome**

If anything fails, treat it as a normal debugging cycle. Report what was driven and what the app actually did — do not claim the slice works without this step's output.

---

## Self-Review notes

- **Spec coverage:** singleton table + no seed row (Task 1); brake domain with upsert, DB-backed authz, audit and outbox (Task 2); enforcement at the `advanceRun` choke point plus the fail-safe-not-fail-open rule (Task 3); `audit_log` for the per-run action, closing the US-11.10 gap, and `runStatusSchema` (Task 4); "the parties are notified" (Task 5); both HTTP routes with the full 403/400/409/404 mapping (Task 6); the teardown AC pinned as a regression test and both doc corrections (Task 7); live verification of the whole slice (final section). Every "Out of scope" item in the spec is absent from every task.
- **Placeholders:** none. Every code step is concrete. One step intentionally inspects before editing — Task 1 Step 5 (verify the generated migration SQL, whose filename drizzle-kit randomises) — and states exactly what to look for and what to do if it differs.
- **Pre-flight corrections (2026-08-05, before execution):** (1) shared integration fixtures were extracted to `src/test/agent-delivery-fixtures.ts` in Task 3 rather than duplicating a ~50-line setup helper across Tasks 3-5; the two pre-existing copies (`runToDelivery` in `run-closed.integration.test.ts`, `fundedPublishedProject` in the contract test) are deliberately left alone as out of scope. (2) Task 6 originally assumed `fundedPublishedProject()` funds a pledge and returns a `runId` — it does neither, so the task now drives fund → accept through the routes via a local `runViaRoutes()` helper.
- **Type consistency:** `isAgentDeliveryPaused(db?)` and `setAgentDeliveryPaused(actingUserId, paused, db?)` are defined in Task 2 and used with those signatures in Tasks 3, 5, and 6. `PLATFORM_CONTROLS_ID` and `platformControls` are defined in Task 1 and imported in Task 2. `runStatusSchema` is defined in Task 4 and consumed in Task 6. The `RunStatusChanged` payload gains `charityOrgId`/`corporationOrgId` in Task 4 and is read with exactly those names in Task 5. `advanceRun`'s `{ ran, status, phase }` return shape is unchanged throughout.
- **Known caveat:** the platform brake's resume path relies on the 5-minute reconciliation sweep, so Task 3's integration tests call `advanceRun` directly rather than waiting on the worker; the live-verification section is what exercises the sweep.

---

## Live-verification outcome (2026-08-31)

Driven against the real stack (docker compose db + mailhog, `npm run db:migrate`, `npm run db:seed`, dev server on :3000, worker on :8080) with the seeded accounts. Run id `84ebf883-…`, project "Kill-switch verification project" (Helping Hands), funded by Globex at `budgetMinor: 50000`, template `static-site`, fake ModelProvider.

| Step | Driven | What the app actually did |
|---|---|---|
| 2 | Login as all three seeded roles | `{"ok":true,"isPlatformAdmin":true}` for admin; `false` for charity/corp |
| 3 | `POST /api/admin/agent-delivery/brake {"paused":true}`, then fund → accept | `{"ok":true,"agentDeliveryPaused":true}`. Worker logged `agent.advance 84ebf883-… requirements authorized false` — run stayed `authorized`, **0** milestones written |
| 4 | `{"paused":false}` | `{"ok":true,"agentDeliveryPaused":false}`. The reconciliation sweep picked the run up ~100 s later (`reconciliation enqueued 1 run(s)` → `agent.advance … requirements awaiting_gate true`); run reached `awaiting_gate` with one `requirements` milestone `awaiting_review` |
| 5 | `POST /api/admin/runs/<id>/status {"status":"halted"}` | `{"ok":true,"status":"halted"}`; run `halted` |

Status-code matrix, all as specified: halt **200**, re-POST `paused` on a terminal run **409**, non-admin per-run **403**, status outside the admin-settable set **400**, unknown run **404**, brake as non-admin **403**, malformed brake body **400**.

Notifications — both parties, one row each:

```
agent_run.halted | charity@hodorhub.test
agent_run.halted | corp@hodorhub.test
```

Audit log — exactly one row per admin action, no row for the rejected non-admin attempts:

```
agent_delivery.brake.pulled    | platform_controls   | admin@hodorhub.test | {"agentDeliveryPaused": true}
agent_delivery.brake.released  | platform_controls   | admin@hodorhub.test | {"agentDeliveryPaused": false}
agent_delivery.run.halted      | agent_delivery_run  | admin@hodorhub.test | {"status":"halted","previousStatus":"awaiting_gate"}
```

**Gate at verification time:** typecheck, `format:check`, lint clean; **115 unit tests / 24 files**, coverage **96.25 stmts / 92.91 branch**; **164 integration tests / 30 files**; `build:workers` (`grep -c argon2 dist/worker.cjs` = 1, the documented deliberate state) and `build` both clean, with `/api/admin/agent-delivery/brake` and `/api/admin/runs/[id]/status` present in the route manifest.

**Note for future runs:** an abandoned 2026-08-06 verification attempt left the brake *engaged* in the local dev database (an `agent_delivery.brake.pulled` audit row from 07:14 with no matching release). Harmless — dev-only — but a reminder that the brake is deliberately persistent and survives restarts. Release it before wondering why local runs will not advance. The documented curl steps also write `admin.txt`/`charity.txt`/`corp.txt` session-cookie jars into the repo root; this run wrote them to a scratchpad instead, and the stale ones were deleted.

No defects found. US-11.5 verified end to end.
