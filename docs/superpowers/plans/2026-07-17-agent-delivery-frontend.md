# Epic 11 Frontend — hook agent-delivery to the project page

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Expose the agent-delivery pipeline (Epic 11) in the UI so a corporation can fund a compute budget on a project, the charity can accept it, and both can watch/drive the run through its four human-gated phases to a deployed staging URL — reusing the existing project-page panel patterns, with the pg-boss worker advancing runs for real (fake provider).

**Architecture:** New read functions (charity/corp compute-pledge lists + a run-detail read), new thin API routes (mirroring the resource-gift routes), and new client components + project-page wiring (mirroring `OfferGiftForm`/`GiftActions`). No orchestration change — the UI calls the existing services; the already-wired worker (relay → `agent.advance`) advances runs when events fire.

**Tech Stack:** Next.js 15 App Router (server components + `'use client'` islands), Drizzle/Postgres, Vitest integration tests, existing CSS in `src/app/globals.css` (classes `panel`, `gift-row`, `gift-chip`, `gift-actions`, `meter`, `btn`, `btn-ghost`, `support-note`).

## Global Constraints

- **Node ≥ 20**, ESM, `@/` alias. Money = integer minor units; display as `£(minor/100)`.
- **Route pattern (verbatim):** `export async function POST(req, { params })` → `const session = await requireUser()` → `readJson(req)` + zod parse for bodies → call the service with `session.userId` → `NextResponse.json({ ok: true, ... })`; `catch (e) { return errorResponse(e); }`. Auth-required routes use `requireUser()` (throws HttpError 401 → mapped by `errorResponse`).
- **Reads** are server-side only (called from the server-component page), authorize by role, and return `NotFoundError` for cross-tenant (never leak existence) — mirror `listResourceGiftsForProject`.
- **Client components** are `'use client'`, POST via `fetch`, handle 401 ("Sign in to continue."), reload on success (`window.location.reload()`), mirror `GiftActions`/`OfferGiftForm`.
- **Panel gating** mirrors the gift lesson: gate the *new-funding form* on `project.status === 'published'`, but always show an existing run/pledge to its owner regardless of status.
- **Merit integrity:** the page/reads must not introduce any Scoring dependency on agent-delivery (unchanged; the boundary test still guards it).
- Integration/contract tests need a real Postgres: prefix with `TEST_DATABASE_URL=postgres://hodorhub:hodorhub@localhost:5432/hodorhub_test DATABASE_URL=postgres://hodorhub:hodorhub@localhost:5432/hodorhub_test`. **Contract (route) tests need BOTH env vars set to the test DB** (route handlers use the default `db`).
- UI tasks (3–4) have no unit tests (repo has no React test setup); verify via `npm run typecheck`, `npm run lint`, `next build`, and **live driving** with the dev server + worker.

## Current state (merged on main; do not re-create)

- **Services (agent-delivery):** `fundComputeBudget`, `acceptComputePledge` (Commitments); `advanceRun`, `approveMilestone`, `requestChanges`, `rejectMilestone`, `runDeliveryPhase`, `getBalance` (AgentDelivery); the worker (`src/worker/index.ts`) enqueues `agent.advance` on the runnable-making outbox events and runs it on the fake provider/sandbox/deployer.
- **Schema:** `compute_pledges` (status `proposed|accepted|declined`), `agent_delivery_runs` (status, `currentPhase`), `run_milestones` (phase, status `pending|awaiting_review|approved|changes_requested|rejected`, `artifactRef`), `run_budgets`, `deployed_environments` (environment, url, status).
- **Project page:** `src/app/projects/[id]/page.tsx` — role-aware server component; `isCharityOwner` via `findMembership`, `isCorpManager` via `getUserOrg`. Reuse these exact derivations.
- **No compute-pledge decline service, no agent-delivery reads for the UI, and no agent-delivery API routes exist yet** — this plan adds them.

---

### Task 1: Read functions + `declineComputePledge`

**Files:**
- Modify: `src/modules/commitments/service.ts` (+ `index.ts`)
- Create: `src/modules/agent-delivery/reads.ts` (+ export from `index.ts`)
- Test: `src/modules/commitments/compute-pledges.integration.test.ts` (extend), `src/modules/agent-delivery/reads.integration.test.ts` (new)

**Interfaces:**
- Produces (Commitments): `listComputePledgesForProject(actingUserId, projectId, db?)` → charity_owner-only array of the project's compute pledges (cross-tenant/wrong-role → `NotFoundError`/`ForbiddenError`, mirroring `listResourceGiftsForProject`); `listComputePledgesForCorp(actingUserId, projectId, corporationOrgId, db?)` → that corp's pledges on the project (`assertCorpManager`); `declineComputePledge(actingUserId, computePledgeId, reason?, db?)` → charity_owner sets status `declined` (only from `proposed`, else `InvalidStateError`), emits `ComputePledgeDeclined`.
- Produces (AgentDelivery): `getRunForProject(projectId, db?)` → `{ run, milestones, budget: {committedMinor,reservedMinor,consumedMinor,remainingMinor}, deployedEnvironment } | null` for the most-recent run of the project. Unauthenticated read (the page gates display by role); `milestones` ordered by phase.

- [ ] **Step 1: Write failing tests**

Extend `src/modules/commitments/compute-pledges.integration.test.ts` with a block asserting: after `fundComputeBudget`, `listComputePledgesForProject(charity.userId, projectId)` returns the pledge (status `proposed`), a non-owning charity gets `NotFoundError`; `listComputePledgesForCorp(corp.userId, projectId, corp.organisationId)` returns it; and `declineComputePledge(charity.userId, pledgeId)` sets status `declined` + emits `ComputePledgeDeclined` (assert an outbox row), and a second decline throws `InvalidStateError`.

Create `src/modules/agent-delivery/reads.integration.test.ts`: build a run to the requirements gate (fund → accept → `runCurrentPhase` with a `FakeModelProvider`), then `getRunForProject(projectId)` returns `run.currentPhase==='requirements'`, one milestone (`requirements`, `awaiting_review`), `budget.committedMinor===<funded>`, `deployedEnvironment===null`; after driving to delivery + deploy, it returns the `deployedEnvironment` with a staging url.

- [ ] **Step 2: Run — verify they fail.**

- [ ] **Step 3: Implement the Commitments functions**

Add to `src/modules/commitments/service.ts` (import `computePledges`, `agentDeliveryRuns` already present or add; reuse `assertCorpManager`, `getProjectRef`, `findMembership`, error classes):
```ts
/** US-11.1/2 — charity_owner views compute pledges on their project. */
export async function listComputePledgesForProject(actingUserId: string, projectId: string, db: Db = defaultDb) {
  const ref = await getProjectRef(projectId, db);
  if (!ref) throw new NotFoundError('Project');
  const m = await findMembership(actingUserId, ref.charityOrgId, db);
  if (!m) throw new NotFoundError('Project');
  if (m.role !== 'charity_owner') throw new ForbiddenError();
  return db.query.computePledges.findMany({ where: eq(computePledges.projectId, projectId) });
}

/** US-11.1 — a corp's own compute pledges on a project. */
export async function listComputePledgesForCorp(actingUserId: string, projectId: string, corporationOrgId: string, db: Db = defaultDb) {
  await assertCorpManager(db, actingUserId, corporationOrgId);
  return db.query.computePledges.findMany({
    where: and(eq(computePledges.projectId, projectId), eq(computePledges.corporationOrgId, corporationOrgId)),
  });
}

/** US-11.2 — charity_owner declines a proposed compute pledge. */
export async function declineComputePledge(actingUserId: string, computePledgeId: string, reason: string | undefined, db: Db = defaultDb): Promise<void> {
  await db.transaction(async (tx) => {
    const pledge = await tx.query.computePledges.findFirst({ where: eq(computePledges.id, computePledgeId) });
    if (!pledge) throw new NotFoundError('Compute pledge');
    const ref = await getProjectRef(pledge.projectId, tx);
    if (!ref) throw new NotFoundError('Compute pledge');
    const m = await findMembership(actingUserId, ref.charityOrgId, tx);
    if (!m) throw new NotFoundError('Compute pledge');
    if (m.role !== 'charity_owner') throw new ForbiddenError();
    if (pledge.status !== 'proposed') throw new InvalidStateError(`Compute pledge already ${pledge.status}.`);
    await tx.update(computePledges).set({ status: 'declined', decidedBy: actingUserId, reason: reason ?? null }).where(eq(computePledges.id, computePledgeId));
    await tx.insert(outbox).values({ eventType: 'ComputePledgeDeclined', payload: { computePledgeId, projectId: pledge.projectId, corporationOrgId: pledge.corporationOrgId } });
  });
}
```
Ensure `and` is imported from `drizzle-orm`. Export all three from `src/modules/commitments/index.ts`.

- [ ] **Step 4: Implement the AgentDelivery read**

Create `src/modules/agent-delivery/reads.ts`:
```ts
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
  const milestones = await db.query.runMilestones.findMany({ where: eq(runMilestones.runId, run.id) });
  milestones.sort((a, b) => PHASE_ORDER.indexOf(a.phase as never) - PHASE_ORDER.indexOf(b.phase as never));
  const budget = await getBalance(db, run.id);
  const deployedEnvironment =
    (await db.query.deployedEnvironments.findFirst({
      where: and(eq(deployedEnvironments.runId, run.id), eq(deployedEnvironments.status, 'live')),
    })) ?? null;
  return { run, milestones, budget, deployedEnvironment };
}
```
Export from `src/modules/agent-delivery/index.ts`: `export { getRunForProject } from './reads';`.

- [ ] **Step 5: Run tests — verify pass; typecheck; commit**
```bash
npm run typecheck
git add src/modules/commitments/service.ts src/modules/commitments/index.ts src/modules/commitments/compute-pledges.integration.test.ts src/modules/agent-delivery/reads.ts src/modules/agent-delivery/index.ts src/modules/agent-delivery/reads.integration.test.ts
git commit -m "feat(agent-delivery): UI reads (compute-pledge lists, run detail) + declineComputePledge"
```

---

### Task 2: API routes

**Files:**
- Create: `src/app/api/projects/[id]/compute-pledges/route.ts`
- Create: `src/app/api/compute-pledges/[id]/accept/route.ts`, `.../decline/route.ts`
- Create: `src/app/api/agent-milestones/[id]/approve/route.ts`, `.../request-changes/route.ts`, `.../reject/route.ts`
- Test: `src/app/api/agent-delivery.contract.integration.test.ts`

**Interfaces:** thin handlers calling the existing services. Bodies (zod-parsed): fund `{ templateCode: string, budgetMinor: number }`; decline `{ reason?: string }`; request-changes `{ feedback: string }`; reject `{ reason: string }`; accept/approve take no body.

- [ ] **Step 1: Write the contract test (failing)**

`src/app/api/agent-delivery.contract.integration.test.ts` — import the route `POST` handlers directly and invoke with a `Request` + a signed-session cookie (follow the existing `src/app/api/contract.integration.test.ts` `authAs`/`newSession`/`signSession` helper pattern). Assert: unauthenticated fund → 401; charity funds → 403 (only corp funds); corp funds published project → 200 with a `computePledgeId`; charity accepts → 200; a fresh `FakeModelProvider`-driven requirements milestone can be approved via the approve route → 200; wrong-role approve → 403. Keep it focused on wiring (auth + status mapping), not re-testing service internals.

- [ ] **Step 2: Run — verify it fails.**

- [ ] **Step 3: Implement the routes** (all mirror the resource-gift route shape)

`src/app/api/projects/[id]/compute-pledges/route.ts`:
```ts
import { NextResponse } from 'next/server';
import { z } from 'zod';
import { fundComputeBudget } from '@/modules/commitments';
import { requireUser } from '@/lib/auth';
import { errorResponse, readJson } from '@/lib/http';

const schema = z.object({ corporationOrgId: z.string().uuid(), templateCode: z.string(), budgetMinor: z.number().int() });

export async function POST(req: Request, { params }: { params: Promise<{ id: string }> }) {
  try {
    const session = await requireUser();
    const { id } = await params;
    const body = schema.parse(await readJson(req));
    const { computePledgeId } = await fundComputeBudget(session.userId, id, body);
    return NextResponse.json({ ok: true, computePledgeId });
  } catch (e) {
    return errorResponse(e);
  }
}
```
`src/app/api/compute-pledges/[id]/accept/route.ts`:
```ts
import { NextResponse } from 'next/server';
import { acceptComputePledge } from '@/modules/commitments';
import { requireUser } from '@/lib/auth';
import { errorResponse } from '@/lib/http';

export async function POST(_req: Request, { params }: { params: Promise<{ id: string }> }) {
  try {
    const session = await requireUser();
    const { id } = await params;
    const { runId } = await acceptComputePledge(session.userId, id);
    return NextResponse.json({ ok: true, runId });
  } catch (e) {
    return errorResponse(e);
  }
}
```
`src/app/api/compute-pledges/[id]/decline/route.ts` — same shape, `readJson` → `{ reason?: string }` (zod `.object({ reason: z.string().trim().max(500).optional() })`), calls `declineComputePledge(session.userId, id, body.reason)`.

`src/app/api/agent-milestones/[id]/approve/route.ts`:
```ts
import { NextResponse } from 'next/server';
import { approveMilestone } from '@/modules/agent-delivery';
import { requireUser } from '@/lib/auth';
import { errorResponse } from '@/lib/http';

export async function POST(_req: Request, { params }: { params: Promise<{ id: string }> }) {
  try {
    const session = await requireUser();
    const { id } = await params;
    await approveMilestone(session.userId, id);
    return NextResponse.json({ ok: true, status: 'approved' });
  } catch (e) {
    return errorResponse(e);
  }
}
```
`.../request-changes/route.ts` — body `{ feedback: z.string().trim().min(1).max(1000) }` → `requestChanges(session.userId, id, body.feedback)`, returns `{ ok: true, status: 'changes_requested' }`.
`.../reject/route.ts` — body `{ reason: z.string().trim().min(1).max(1000) }` → `rejectMilestone(session.userId, id, body.reason)`, returns `{ ok: true, status: 'rejected' }`.

- [ ] **Step 4: Run the contract test — verify pass; typecheck; commit**
```bash
npm run typecheck
git add src/app/api/projects/[id]/compute-pledges src/app/api/compute-pledges src/app/api/agent-milestones src/app/api/agent-delivery.contract.integration.test.ts
git commit -m "feat(agent-delivery): API routes (fund/accept/decline pledge, milestone gates)"
```

---

### Task 3: Corp funding + charity pledge-decision UI

**Files:**
- Create: `src/app/projects/[id]/FundAgentDeliveryForm.tsx`, `src/app/projects/[id]/ComputePledgeActions.tsx`
- Modify: `src/app/projects/[id]/page.tsx`
- Modify: `src/app/globals.css` (minor additions if needed)

**Interfaces:** `FundAgentDeliveryForm({ projectId, corporationOrgId })` — a template `<select>` (options: `static-site`) + a budget input (in £, converted to minor units) → `POST /api/projects/[id]/compute-pledges`. `ComputePledgeActions({ pledgeId, status })` — for `proposed`: Accept / Decline (reason input on decline), mirroring `GiftActions`; POSTs to `/api/compute-pledges/[id]/{accept,decline}`.

- [ ] **Step 1: Build the components** (mirror `OfferGiftForm`/`GiftActions`; `'use client'`; 401 → "Sign in to continue."; reload on success). Budget input is £ with `inputMode="decimal"`; convert to integer minor units (`Math.round(pounds * 100)`) before POST; reject non-positive.

- [ ] **Step 2: Wire the page** — in `page.tsx`, after computing `isCharityOwner`/`isCorpManager`/`userOrg`, fetch pledges:
```ts
const charityComputePledges = isCharityOwner && session ? await listComputePledgesForProject(session.userId, id) : [];
const corpComputePledges = isCorpManager && session ? await listComputePledgesForCorp(session.userId, id, userOrg!.organisationId) : [];
```
Corp aside panel (only when `isCorpManager && project.status === 'published'` for the *form*; always show existing `corpComputePledges` when `isCorpManager`): "Fund agent delivery" heading + `FundAgentDeliveryForm` + a "Your compute pledges" list with status chips. Charity main-column panel (when `isCharityOwner`): "Agent delivery offers" listing `charityComputePledges`; for a `proposed` one render `ComputePledgeActions`. Use the existing `panel`/`gift-row`/`gift-chip`/`gift-chip-<status>` classes; add `gift-chip-proposed`/`accepted`/`declined` colors to globals if missing.

- [ ] **Step 3: Verify** — `npm run typecheck && npm run lint`, then `next build` must succeed. Then live-drive (Task 5 covers the full worker-driven drive; here just confirm the corp funding form renders and a fund→accept round-trips via the API against the dev server). Commit:
```bash
git add src/app/projects/[id]/FundAgentDeliveryForm.tsx src/app/projects/[id]/ComputePledgeActions.tsx src/app/projects/[id]/page.tsx src/app/globals.css
git commit -m "feat(ui): corp fund-agent-delivery form + charity compute-pledge accept/decline"
```

---

### Task 4: Agent-run panel + milestone gates + full live drive

**Files:**
- Create: `src/app/projects/[id]/AgentRunPanel.tsx`, `src/app/projects/[id]/MilestoneGateActions.tsx`
- Modify: `src/app/projects/[id]/page.tsx`, `src/app/globals.css`

**Interfaces:** `AgentRunPanel({ run, milestones, budget, deployedEnvironment, canReview })` — a server-rendered panel: run status + current phase; a 4-row phase timeline (requirements → design → build → delivery) each showing the milestone status chip + a truncated `artifactRef` preview; a budget line (committed / consumed / remaining, `£`); the deployed **staging URL** as a link when `deployedEnvironment` is live; and, when `canReview` and a milestone is `awaiting_review`, a `MilestoneGateActions` for that milestone. `MilestoneGateActions({ milestoneId })` (`'use client'`) — Approve / Request changes (feedback input) / Reject (reason input), POST to `/api/agent-milestones/[id]/{approve,request-changes,reject}`, reload on success (mirror `GiftActions`).

- [ ] **Step 1: Build the components.** Phase timeline maps `['requirements','design','build','delivery']`, finding each milestone by phase (may be absent → "pending"). `canReview = isCharityOwner`. Truncate `artifactRef` to ~140 chars. Budget shown via `£(minor/100).toFixed(2)`.

- [ ] **Step 2: Wire the page** — fetch `const runDetail = session ? await getRunForProject(id) : null;` and show `AgentRunPanel` when `runDetail` exists AND the viewer is the charity owner or the funding corp (`isCorpManager && userOrg!.organisationId === runDetail.run.corporationOrgId`). Pass `canReview={isCharityOwner}`. Show it regardless of project status (a run continues through `in_delivery`).

- [ ] **Step 3: Add CSS** for the phase timeline (`.phase-row`, `.phase-dot` states) and budget line — small additions to `globals.css`, consistent with the existing dark/parchment palette.

- [ ] **Step 4: Verify — typecheck + lint + build**
```bash
npm run typecheck && npm run lint && npm run build 2>&1 | tail -5
```

- [ ] **Step 5: Full live end-to-end drive (with the worker)**

Start Postgres (`docker compose up -d db`), the dev server (`npm run dev`), and **the worker** in a third process so runs advance:
```bash
# worker needs the app env; load it from .env.local
tsx --env-file=.env.local src/worker/index.ts   # or: npm run worker with env exported
```
Then, signed in as the seed **corp** (`corp@hodorhub.test`) on the seed charity's published project: fund a budget → sign in as **charity** (`charity@hodorhub.test`) → accept → the worker advances the run to the requirements gate → approve → design gate → approve → build gate → approve → delivery gate → approve → **deployed staging URL** shows. Confirm the budget line moves and the run reaches `completed`. Screenshot the run panel at a gate and at completion; **look at the screenshots**.

- [ ] **Step 6: Commit**
```bash
git add src/app/projects/[id]/AgentRunPanel.tsx src/app/projects/[id]/MilestoneGateActions.tsx src/app/projects/[id]/page.tsx src/app/globals.css
git commit -m "feat(ui): agent-run panel with phase timeline, budget + milestone gates"
```

---

## What this slice delivers

On the project page: a corporation funds an agent-delivery compute budget; the charity accepts; both watch a live run panel advance through requirements → design → build → delivery with the charity approving/requesting-changes/rejecting at each gate; the budget draws down; and the deployed staging URL appears — all driven for real by the worker on the fake provider.

## Explicitly out of scope

Admin kill-switch UI; production-promotion gate (US-11.8); multiple concurrent runs / pagination; real provider/sandbox/deploy (Slice 3b); notifications UI for agent-delivery events.

## Self-review notes

- **Spec coverage:** funding (Task 2/3), accept/decline (1/2/3), run display + gates (1/2/4), deployed URL (1/4). Worker-driven advance is a runtime step (Task 4 Step 5), not new code.
- **Pattern fidelity:** routes mirror `resource-gifts/*`; client components mirror `GiftActions`/`OfferGiftForm`; reads mirror `listResourceGiftsFor*`; panel gating mirrors the gift lesson (gate the form, always show existing).
- **No unit tests for React** (repo has none) — UI verified by typecheck + lint + `next build` + live driving; the reads/routes ARE covered by integration/contract tests.
- **Type/name consistency:** `getRunForProject` return shape (`{run,milestones,budget,deployedEnvironment}`) is consumed identically by the page and `AgentRunPanel`; budget fields match `getBalance`.
- **Known caveat (documented, not fixed here):** `acceptComputePledge` calls `beginDelivery` (published→in_delivery); a project already in delivery via a normal pledge would throw — out of scope, the seed project is fresh.
