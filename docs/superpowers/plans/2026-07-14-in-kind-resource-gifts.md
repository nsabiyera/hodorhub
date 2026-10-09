# In-kind Digital Resource Gifts Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Let a charity declare a project's digital-resource needs (cloud credits, API/LLM budget, SaaS seats, hosting, domains) and let a verified corporation fulfil them through an offer → accept/decline → provided → received flow that HodorHub records but never provisions, values, or lets influence merit.

**Architecture:** Reuse the existing needs → offer → accept → confirm *patterns*, not the tables. A new `digital_resource_needs` table lives in the **Projects** module (sibling to `project_resource_needs`); a new `resource_gifts` table lives in the **Commitments** module (sibling to `pledges`, in a new `gifts.ts` file). Gift acceptance never touches the delivery machinery. Merit integrity is structural: Scoring has no subscription surface, reads a closed source allowlist over tables gifts don't live in, and a boundary test forbids `scoring`/`discovery` from referencing `resource_gifts`.

**Tech Stack:** Next.js 15 App Router (route handlers), TypeScript, Drizzle ORM + PostgreSQL, Zod, Vitest (integration harness against a real `hodorhub_test` DB), transactional outbox → Notifications relay.

## Global Constraints

- **Coordination-only.** No column ever stores a monetary amount/currency; HodorHub transfers/provisions nothing. Optional `quantity` is an integer and `unit` is a free string only.
- **Merit is never for sale.** A resource gift (offered, accepted, provided, or received) must never be an input to `project_scores` or to any discovery `ORDER BY`/filter, and must never place donor branding on the neutral marketplace.
- **Gift acceptance is not delivery.** Accepting a gift must NOT create `delivery_workspaces`/`allocations`/`hour_logs` and must NOT move the project to `in_delivery`.
- **Verified-actor gates.** Offering requires the acting user is a `csr_manager` of a *verified* corporation and the project is `published`. Charity decisions require the acting user is a `charity_owner` of the project's charity. Reuse `assertCorpManager`, `findMembership`, `getProjectRef`.
- **Modules never touch each other's tables.** Commitments reaches Projects only through its public interface (`getProjectRef`, `DIGITAL_RESOURCE_KINDS`). No module reads another's tables.
- **Enum literals are frozen now.** Define the full `resource_gift_status` enum up front even though the Must slice only exercises `offered/accepted/declined`.
- **Verification commands** (run from repo root): `npm run typecheck`, `npm run lint`, `npm run test:integration`, `npm run test` (unit), `npm run format:check`. Migrations: `npm run db:generate` then the integration harness auto-migrates `hodorhub_test`; dev DB is migrated with `DATABASE_URL=postgres://hodorhub:hodorhub@localhost:5432/hodorhub npm run db:migrate`.

**Out of scope for this plan (Release 2+, per the spec):** external API auto-provisioning, £ valuation, tax/Gift Aid, donor recognition badges, a company-PUSH offers marketplace, matching/recommendations, CSR-dashboard rollups, and front-end forms. Like the rest of Commitments, this plan ships the capability at the service + API + integration-test layer; the project-detail/edit **form UI is a separate follow-up plan**.

---

### Task 1: Schema — enums + two sibling tables + migration

**Files:**
- Modify: `src/db/schema.ts` (add two enums near the other `pgEnum`s ~line 59; add `digitalResourceNeeds` after `projectResourceNeeds` ~line 193; add `resourceGifts` after `pledges` ~line 292)
- Generate: `drizzle/0008_*.sql` (via `npm run db:generate`)

**Interfaces:**
- Produces (imported by later tasks from `@/db/schema`): `digitalResourceKind`, `resourceGiftStatus` (pgEnums); `digitalResourceNeeds`, `resourceGifts` (tables).

- [ ] **Step 1: Add the two enums** to `src/db/schema.ts` immediately after the `reportStatus` enum (line 59):

```typescript
export const digitalResourceKind = pgEnum('digital_resource_kind', [
  'cloud_credits',
  'api_budget',
  'llm_budget',
  'saas_seats',
  'hosting',
  'domains',
  'other',
]);
export const resourceGiftStatus = pgEnum('resource_gift_status', [
  'offered',
  'accepted',
  'declined',
  'provided',
  'received',
  'withdrawn',
]);
```

- [ ] **Step 2: Add the `digital_resource_needs` table** immediately after `projectResourceNeeds` (after line 193):

```typescript
// Sibling to project_resource_needs: the non-human resources a software
// project consumes (US-2.7). Coordination-only — quantity/unit are informational,
// never a monetary value.
export const digitalResourceNeeds = pgTable('digital_resource_needs', {
  id: uuid('id').primaryKey().defaultRandom(),
  projectId: uuid('project_id')
    .notNull()
    .references(() => projects.id),
  kind: digitalResourceKind('kind').notNull(),
  description: text('description'),
  quantity: integer('quantity'),
  unit: text('unit'),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
});
```

- [ ] **Step 3: Add the `resource_gifts` table** immediately after the `pledges` table definition (after line 292). Note the deliberate divergences from `pledges`: no single-accept unique index, no delivery FK, richer isolated status enum, no monetary column.

```typescript
// Commitments sibling aggregate to `pledges` (US-5.5/US-6.5). A corporation's
// in-kind gift toward a project's digital-resource need. Coordination-only:
// HodorHub records the gift, provisions/values nothing. Deliberately NOT a
// `kind` on pledges — many gifts per project are allowed, and acceptance must
// never enter the delivery machinery.
export const resourceGifts = pgTable('resource_gifts', {
  id: uuid('id').primaryKey().defaultRandom(),
  projectId: uuid('project_id')
    .notNull()
    .references(() => projects.id),
  corporationOrgId: uuid('corporation_org_id')
    .notNull()
    .references(() => organisations.id),
  needId: uuid('need_id').references(() => digitalResourceNeeds.id), // nullable: PULL default, PUSH-ready
  kind: digitalResourceKind('kind').notNull(),
  quantity: integer('quantity'),
  unit: text('unit'),
  note: text('note'),
  status: resourceGiftStatus('status').notNull().default('offered'),
  decidedBy: uuid('decided_by').references(() => users.id),
  providedAt: timestamp('provided_at', { withTimezone: true }),
  receivedAt: timestamp('received_at', { withTimezone: true }),
  reason: text('reason'),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
});
```

- [ ] **Step 4: Generate the migration**

Run: `npm run db:generate`
Expected: a new `drizzle/0008_*.sql` is created containing `CREATE TYPE ... digital_resource_kind`, `CREATE TYPE ... resource_gift_status`, `CREATE TABLE digital_resource_needs`, `CREATE TABLE resource_gifts`. No prompts (purely additive).

- [ ] **Step 5: Typecheck + apply to dev DB**

Run: `npm run typecheck`
Expected: PASS (no output).
Run: `DATABASE_URL=postgres://hodorhub:hodorhub@localhost:5432/hodorhub npm run db:migrate`
Expected: `migrations applied successfully`.

- [ ] **Step 6: Commit**

```bash
git add src/db/schema.ts drizzle/
git commit -m "feat(db): digital_resource_needs + resource_gifts tables (US-2.7/5.5)"
```

---

### Task 2: Projects — declare digital-resource needs (US-2.7)

**Files:**
- Modify: `src/modules/projects/service.ts` (add `DIGITAL_RESOURCE_KINDS`, `digitalResourceNeedSchema`, `setDigitalResourceNeeds`; extend `getProjectForOwner` and `getPublishedProject` return values)
- Modify: `src/modules/projects/index.ts` (export the new symbols)
- Create: `src/app/api/projects/[id]/digital-resource-needs/route.ts`
- Test: `src/modules/projects/digital-resource-needs.integration.test.ts`

**Interfaces:**
- Consumes: `digitalResourceNeeds` table (Task 1); existing `loadOwnedProject`, `EDITABLE_STATES`, `outbox` in `service.ts`.
- Produces:
  - `DIGITAL_RESOURCE_KINDS: readonly ['cloud_credits','api_budget','llm_budget','saas_seats','hosting','domains','other']`
  - `type DigitalResourceKind`
  - `digitalResourceNeedSchema` (Zod) with fields `{ kind: DigitalResourceKind; description?: string; quantity?: number; unit?: string }`
  - `setDigitalResourceNeeds(actingUserId: string, projectId: string, needs: DigitalResourceNeedInput[], db?): Promise<void>`
  - `getProjectForOwner` / `getPublishedProject` now also return `digitalResourceNeeds` on the project object.

- [ ] **Step 1: Write the failing test** — create `src/modules/projects/digital-resource-needs.integration.test.ts`:

```typescript
import { describe, it, expect } from 'vitest';
import { eq } from 'drizzle-orm';
import { testDb } from '@/test/db';
import { digitalResourceNeeds } from '@/db/schema';
import { registerCharity, approveVerification, createPlatformAdmin } from '@/modules/identity';
import {
  createDraftProject,
  setResourceNeeds,
  publishProject,
  setDigitalResourceNeeds,
  getPublishedProject,
} from './service';

const need = {
  skill: 'Backend development',
  role: 'Backend developer',
  kind: 'ongoing' as const,
  quantity: 1,
  hoursPerWeek: 2,
  durationWeeks: 8,
};

async function publishedProject() {
  const admin = await createPlatformAdmin('admin@hh.com', 'admin-password-1', testDb);
  const charity = await registerCharity(
    { email: 'petra@goodcause.org', password: 'a-strong-password', charityName: 'Good Cause', regNumber: 'CH-1' },
    testDb,
  );
  await approveVerification(charity.verificationRequestId, admin, testDb);
  const { projectId } = await createDraftProject(
    charity.userId,
    { charityOrgId: charity.organisationId, title: 'Rebuild the community garden', description: 'A worthy cause that needs a hand.', goal: 'Reach the finish line.', category: 'software' },
    testDb,
  );
  await setResourceNeeds(charity.userId, projectId, [need], testDb);
  await publishProject(charity.userId, projectId, testDb);
  return { charity, projectId };
}

describe('Projects — digital-resource needs (US-2.7)', () => {
  it('declares digital-resource needs with optional quantity+unit and exposes them on the read model', async () => {
    const { charity, projectId } = await publishedProject();
    await setDigitalResourceNeeds(
      charity.userId,
      projectId,
      [
        { kind: 'saas_seats', description: 'GitHub Team seats', quantity: 5, unit: 'seats' },
        { kind: 'cloud_credits', description: 'AWS credits for hosting' },
      ],
      testDb,
    );
    const rows = await testDb.query.digitalResourceNeeds.findMany({
      where: eq(digitalResourceNeeds.projectId, projectId),
    });
    expect(rows).toHaveLength(2);
    const seats = rows.find((r) => r.kind === 'saas_seats');
    expect(seats?.quantity).toBe(5);
    expect(seats?.unit).toBe('seats');
    const credits = rows.find((r) => r.kind === 'cloud_credits');
    expect(credits?.quantity).toBeNull(); // no monetary value, quantity optional

    const pub = await getPublishedProject(projectId, testDb);
    expect(pub?.digitalResourceNeeds).toHaveLength(2);
  });

  it('replaces the set (replace-all, like time needs)', async () => {
    const { charity, projectId } = await publishedProject();
    await setDigitalResourceNeeds(charity.userId, projectId, [{ kind: 'domains' }], testDb);
    await setDigitalResourceNeeds(charity.userId, projectId, [{ kind: 'llm_budget', unit: 'USD credits' }], testDb);
    const rows = await testDb.query.digitalResourceNeeds.findMany({
      where: eq(digitalResourceNeeds.projectId, projectId),
    });
    expect(rows).toHaveLength(1);
    expect(rows[0]!.kind).toBe('llm_budget');
  });

  it('rejects an unknown kind', async () => {
    const { charity, projectId } = await publishedProject();
    await expect(
      // @ts-expect-error invalid kind
      setDigitalResourceNeeds(charity.userId, projectId, [{ kind: 'bitcoins' }], testDb),
    ).rejects.toBeInstanceOf(Error);
  });
});
```

- [ ] **Step 2: Run it to verify it fails**

Run: `npm run test:integration -- src/modules/projects/digital-resource-needs.integration.test.ts`
Expected: FAIL — `setDigitalResourceNeeds` / `getPublishedProject.digitalResourceNeeds` not defined.

- [ ] **Step 3: Add the const, type, schema and service function** to `src/modules/projects/service.ts`. Add the import of the table to the existing `@/db/schema` import line, then add near `resourceNeedSchema` (~line 63):

```typescript
export const DIGITAL_RESOURCE_KINDS = [
  'cloud_credits',
  'api_budget',
  'llm_budget',
  'saas_seats',
  'hosting',
  'domains',
  'other',
] as const;
export type DigitalResourceKind = (typeof DIGITAL_RESOURCE_KINDS)[number];

export const digitalResourceNeedSchema = z.object({
  kind: z.enum(DIGITAL_RESOURCE_KINDS),
  description: z.string().trim().max(500).optional(),
  quantity: z.number().int().min(1).max(1_000_000).optional(),
  unit: z.string().trim().max(60).optional(),
});
export type DigitalResourceNeedInput = z.infer<typeof digitalResourceNeedSchema>;
```

Add the service function next to `setResourceNeeds` (mirrors it; note the separate table and no monetary value):

```typescript
export async function setDigitalResourceNeeds(
  actingUserId: string,
  projectId: string,
  needs: DigitalResourceNeedInput[],
  db: Db = defaultDb,
): Promise<void> {
  const parsed = needs.map((n) => digitalResourceNeedSchema.parse(n));
  await db.transaction(async (tx) => {
    const project = await loadOwnedProject(tx, actingUserId, projectId);
    if (!EDITABLE_STATES.includes(project.status)) {
      throw new InvalidStateError('Resource needs can only be changed on draft or published projects.');
    }
    await tx.delete(digitalResourceNeeds).where(eq(digitalResourceNeeds.projectId, projectId));
    if (parsed.length > 0) {
      await tx.insert(digitalResourceNeeds).values(
        parsed.map((n) => ({
          projectId,
          kind: n.kind,
          description: n.description ?? null,
          quantity: n.quantity ?? null,
          unit: n.unit ?? null,
        })),
      );
    }
    await tx.update(projects).set({ updatedAt: sql`now()` }).where(eq(projects.id, projectId));
  });
}
```

Add `digitalResourceNeeds` to the `@/db/schema` import at the top of `service.ts`.

- [ ] **Step 4: Extend the two read models.** In `getProjectForOwner` and `getPublishedProject`, after the existing `resourceNeeds` query, add the digital needs and include them in the returned object. In each, change:

```typescript
  const needs = await db.query.projectResourceNeeds.findMany({
    where: eq(projectResourceNeeds.projectId, projectId),
  });
  return { ...project, resourceNeeds: needs };
```
to:
```typescript
  const needs = await db.query.projectResourceNeeds.findMany({
    where: eq(projectResourceNeeds.projectId, projectId),
  });
  const digital = await db.query.digitalResourceNeeds.findMany({
    where: eq(digitalResourceNeeds.projectId, projectId),
  });
  return { ...project, resourceNeeds: needs, digitalResourceNeeds: digital };
```

- [ ] **Step 5: Export the new symbols** — add to `src/modules/projects/index.ts` inside the existing export block:

```typescript
  setDigitalResourceNeeds,
  digitalResourceNeedSchema,
  DIGITAL_RESOURCE_KINDS,
  type DigitalResourceKind,
  type DigitalResourceNeedInput,
```

- [ ] **Step 6: Run the test to verify it passes**

Run: `npm run test:integration -- src/modules/projects/digital-resource-needs.integration.test.ts`
Expected: PASS (3 tests).

- [ ] **Step 7: Add the API route** — create `src/app/api/projects/[id]/digital-resource-needs/route.ts` (mirrors the time-needs route):

```typescript
import { NextResponse } from 'next/server';
import { z } from 'zod';
import { setDigitalResourceNeeds, digitalResourceNeedSchema } from '@/modules/projects';
import { requireUser } from '@/lib/auth';
import { readJson, errorResponse } from '@/lib/http';

const schema = z.object({ needs: z.array(digitalResourceNeedSchema) });

// US-2.7 — replace the project's digital-resource needs.
export async function PUT(req: Request, { params }: { params: Promise<{ id: string }> }) {
  try {
    const session = await requireUser();
    const { id } = await params;
    const { needs } = schema.parse(await readJson(req));
    await setDigitalResourceNeeds(session.userId, id, needs);
    return NextResponse.json({ ok: true });
  } catch (e) {
    return errorResponse(e);
  }
}
```

- [ ] **Step 8: Typecheck, lint, commit**

Run: `npm run typecheck && npm run lint`
Expected: PASS.
```bash
git add src/modules/projects/ src/app/api/projects/\[id\]/digital-resource-needs/
git commit -m "feat(projects): declare digital-resource needs (US-2.7)"
```

---

### Task 3: Commitments — offer a resource gift, accept/decline (US-5.5)

**Files:**
- Modify: `src/modules/commitments/service.ts` (add `export` to `assertCorpManager` so the gifts file can reuse it)
- Create: `src/modules/commitments/gifts.ts`
- Modify: `src/modules/commitments/index.ts` (export the gift API)
- Create: `src/app/api/projects/[id]/resource-gifts/route.ts` (offer + list)
- Create: `src/app/api/resource-gifts/[id]/accept/route.ts`
- Create: `src/app/api/resource-gifts/[id]/decline/route.ts`
- Test: `src/modules/commitments/resource-gifts.integration.test.ts`

**Interfaces:**
- Consumes: `resourceGifts` table (Task 1); `getProjectRef` (Projects); `findMembership`, `NotFoundError`, `ForbiddenError`, `InvalidStateError` (Identity); `DIGITAL_RESOURCE_KINDS` (Projects); `assertCorpManager` (now exported from `service.ts`).
- Produces:
  - `resourceGiftSchema` (Zod) `{ corporationOrgId: string; needId?: string; kind: DigitalResourceKind; quantity?: number; unit?: string; note?: string }`
  - `offerResourceGift(actingUserId, projectId, input, db?): Promise<{ giftId: string }>`
  - `listResourceGiftsForProject(actingUserId, projectId, db?): Promise<ResourceGift[]>`
  - `acceptResourceGift(actingUserId, giftId, db?): Promise<void>`
  - `declineResourceGift(actingUserId, giftId, reason, db?): Promise<void>`

- [ ] **Step 1: Export the shared authz helper.** In `src/modules/commitments/service.ts`, change `async function assertCorpManager(` to `export async function assertCorpManager(`.

- [ ] **Step 2: Write the failing test** — create `src/modules/commitments/resource-gifts.integration.test.ts`:

```typescript
import { describe, it, expect } from 'vitest';
import { eq } from 'drizzle-orm';
import { testDb } from '@/test/db';
import { resourceGifts, projects, deliveryWorkspaces } from '@/db/schema';
import {
  registerCharity,
  registerCorporation,
  approveVerification,
  createPlatformAdmin,
  ForbiddenError,
  NotFoundError,
  InvalidStateError,
} from '@/modules/identity';
import { createDraftProject, setResourceNeeds, publishProject } from '@/modules/projects';
import {
  offerResourceGift,
  listResourceGiftsForProject,
  acceptResourceGift,
  declineResourceGift,
} from './gifts';

const need = { skill: 'Backend', role: 'Backend dev', kind: 'ongoing' as const, quantity: 1, hoursPerWeek: 2, durationWeeks: 8 };

async function scenario() {
  const admin = await createPlatformAdmin('admin@hh.com', 'admin-password-1', testDb);
  const charity = await registerCharity(
    { email: 'petra@goodcause.org', password: 'a-strong-password', charityName: 'Good Cause', regNumber: 'CH-1' },
    testDb,
  );
  await approveVerification(charity.verificationRequestId, admin, testDb);
  const corp = await registerCorporation(
    { email: 'carlos@acme.com', password: 'a-strong-password', companyName: 'Acme', emailDomain: 'acme.com' },
    testDb,
  );
  await approveVerification(corp.verificationRequestId, admin, testDb);
  const { projectId } = await createDraftProject(
    charity.userId,
    { charityOrgId: charity.organisationId, title: 'Rebuild the community garden', description: 'A worthy cause that needs a hand.', goal: 'Reach the finish line.', category: 'software' },
    testDb,
  );
  await setResourceNeeds(charity.userId, projectId, [need], testDb);
  await publishProject(charity.userId, projectId, testDb);
  return { admin, charity, corp, projectId };
}
const gift = (corporationOrgId: string) => ({ corporationOrgId, kind: 'cloud_credits' as const, quantity: 500, unit: 'USD credits', note: 'From our AWS allowance' });

describe('Commitments — resource gifts (US-5.5)', () => {
  it('offers a gift that awaits charity acceptance', async () => {
    const { charity, corp, projectId } = await scenario();
    const { giftId } = await offerResourceGift(corp.userId, projectId, gift(corp.organisationId), testDb);
    const row = await testDb.query.resourceGifts.findFirst({ where: eq(resourceGifts.id, giftId) });
    expect(row?.status).toBe('offered');
    const list = await listResourceGiftsForProject(charity.userId, projectId, testDb);
    expect(list.map((g) => g.id)).toContain(giftId);
  });

  it('charity accepts a gift WITHOUT starting delivery (no workspace, project stays published)', async () => {
    const { charity, corp, projectId } = await scenario();
    const { giftId } = await offerResourceGift(corp.userId, projectId, gift(corp.organisationId), testDb);
    await acceptResourceGift(charity.userId, giftId, testDb);
    const row = await testDb.query.resourceGifts.findFirst({ where: eq(resourceGifts.id, giftId) });
    expect(row?.status).toBe('accepted');
    const proj = await testDb.query.projects.findFirst({ where: eq(projects.id, projectId) });
    expect(proj?.status).toBe('published'); // NOT in_delivery
    const ws = await testDb.query.deliveryWorkspaces.findMany({ where: eq(deliveryWorkspaces.projectId, projectId) });
    expect(ws).toHaveLength(0); // gift acceptance is not delivery
  });

  it('allows MANY accepted gifts per project (no single-accept collision)', async () => {
    const { charity, corp, projectId } = await scenario();
    const a = await offerResourceGift(corp.userId, projectId, { ...gift(corp.organisationId), kind: 'cloud_credits' }, testDb);
    const b = await offerResourceGift(corp.userId, projectId, { ...gift(corp.organisationId), kind: 'llm_budget' }, testDb);
    await acceptResourceGift(charity.userId, a.giftId, testDb);
    await acceptResourceGift(charity.userId, b.giftId, testDb);
    const accepted = (await listResourceGiftsForProject(charity.userId, projectId, testDb)).filter((g) => g.status === 'accepted');
    expect(accepted).toHaveLength(2);
  });

  it('charity declines with a required reason', async () => {
    const { charity, corp, projectId } = await scenario();
    const { giftId } = await offerResourceGift(corp.userId, projectId, gift(corp.organisationId), testDb);
    await expect(declineResourceGift(charity.userId, giftId, '   ', testDb)).rejects.toBeInstanceOf(InvalidStateError);
    await declineResourceGift(charity.userId, giftId, 'Already covered by another donor', testDb);
    const row = await testDb.query.resourceGifts.findFirst({ where: eq(resourceGifts.id, giftId) });
    expect(row?.status).toBe('declined');
    expect(row?.reason).toBe('Already covered by another donor');
  });

  it('cannot offer to a non-published project; non-CSR and cross-tenant are refused', async () => {
    const { charity, corp } = await scenario();
    const draft = await createDraftProject(
      charity.userId,
      { charityOrgId: charity.organisationId, title: 'Draft only' },
      testDb,
    );
    await expect(offerResourceGift(corp.userId, draft.projectId, gift(corp.organisationId), testDb)).rejects.toBeInstanceOf(InvalidStateError);
    // a charity user is not a CSR manager of the corp
    await expect(offerResourceGift(charity.userId, draft.projectId, gift(corp.organisationId), testDb)).rejects.toBeInstanceOf(NotFoundError);
  });

  it('dedupes a duplicate live offer for the same (project, corp, need)', async () => {
    const { charity, corp, projectId } = await scenario();
    // need a real need id to trigger dedupe path
    const { setDigitalResourceNeeds } = await import('@/modules/projects');
    await setDigitalResourceNeeds(charity.userId, projectId, [{ kind: 'cloud_credits' }], testDb);
    const { digitalResourceNeeds } = await import('@/db/schema');
    const [n] = await testDb.query.digitalResourceNeeds.findMany({ where: eq(digitalResourceNeeds.projectId, projectId) });
    const withNeed = { ...gift(corp.organisationId), needId: n!.id };
    await offerResourceGift(corp.userId, projectId, withNeed, testDb);
    await expect(offerResourceGift(corp.userId, projectId, withNeed, testDb)).rejects.toBeInstanceOf(InvalidStateError);
  });
});
```

- [ ] **Step 3: Run it to verify it fails**

Run: `npm run test:integration -- src/modules/commitments/resource-gifts.integration.test.ts`
Expected: FAIL — `./gifts` module / functions not defined.

- [ ] **Step 4: Implement `src/modules/commitments/gifts.ts`:**

```typescript
import { and, eq, inArray } from 'drizzle-orm';
import { z } from 'zod';
import { db as defaultDb } from '@/db';
import { resourceGifts, outbox } from '@/db/schema';
import { findMembership, NotFoundError, ForbiddenError, InvalidStateError } from '@/modules/identity';
import { getProjectRef, DIGITAL_RESOURCE_KINDS } from '@/modules/projects';
import { assertCorpManager } from './service';

type Db = typeof defaultDb;
type Tx = Parameters<Parameters<Db['transaction']>[0]>[0];
type Executor = Db | Tx;

export const resourceGiftSchema = z.object({
  corporationOrgId: z.string().uuid(),
  needId: z.string().uuid().optional(),
  kind: z.enum(DIGITAL_RESOURCE_KINDS),
  quantity: z.number().int().min(1).max(1_000_000).optional(),
  unit: z.string().trim().max(60).optional(),
  note: z.string().trim().max(500).optional(),
});
export type ResourceGiftInput = z.infer<typeof resourceGiftSchema>;

const LIVE_STATES = ['offered', 'accepted', 'provided'] as const;

// A charity_owner acting on a gift for their own project.
async function loadGiftAsCharityOwner(exec: Executor, userId: string, giftId: string) {
  const g = await exec.query.resourceGifts.findFirst({ where: eq(resourceGifts.id, giftId) });
  if (!g) throw new NotFoundError('Resource gift');
  const ref = await getProjectRef(g.projectId, exec);
  if (!ref) throw new NotFoundError('Resource gift');
  const m = await findMembership(userId, ref.charityOrgId, exec);
  if (!m) throw new NotFoundError('Resource gift'); // cross-tenant: no existence leak
  if (m.role !== 'charity_owner') throw new ForbiddenError();
  return { gift: g };
}

// ── US-5.5 offer ────────────────────────────────────────────────────────────
export async function offerResourceGift(
  actingUserId: string,
  projectId: string,
  input: ResourceGiftInput,
  db: Db = defaultDb,
): Promise<{ giftId: string }> {
  const v = resourceGiftSchema.parse(input);
  return db.transaction(async (tx) => {
    await assertCorpManager(tx, actingUserId, v.corporationOrgId);
    const ref = await getProjectRef(projectId, tx);
    if (!ref) throw new NotFoundError('Project');
    if (ref.status !== 'published') {
      throw new InvalidStateError('This project is not open for new resource gifts.');
    }
    // Natural dedupe: one live offer per (project, corp, need) when a need is targeted.
    if (v.needId) {
      const existing = await tx.query.resourceGifts.findFirst({
        where: and(
          eq(resourceGifts.projectId, projectId),
          eq(resourceGifts.corporationOrgId, v.corporationOrgId),
          eq(resourceGifts.needId, v.needId),
          inArray(resourceGifts.status, [...LIVE_STATES]),
        ),
      });
      if (existing) throw new InvalidStateError('You already have an active gift offer for this need.');
    }
    const [row] = await tx
      .insert(resourceGifts)
      .values({
        projectId,
        corporationOrgId: v.corporationOrgId,
        needId: v.needId ?? null,
        kind: v.kind,
        quantity: v.quantity ?? null,
        unit: v.unit ?? null,
        note: v.note ?? null,
        status: 'offered',
      })
      .returning({ id: resourceGifts.id });
    await tx.insert(outbox).values({
      eventType: 'ResourceGiftOffered',
      payload: { giftId: row!.id, projectId, corporationOrgId: v.corporationOrgId },
    });
    return { giftId: row!.id };
  });
}

/** US-5.5 — charity views resource gifts on its project. */
export async function listResourceGiftsForProject(actingUserId: string, projectId: string, db: Db = defaultDb) {
  const ref = await getProjectRef(projectId, db);
  if (!ref) throw new NotFoundError('Project');
  const m = await findMembership(actingUserId, ref.charityOrgId, db);
  if (!m) throw new NotFoundError('Project');
  if (m.role !== 'charity_owner') throw new ForbiddenError();
  return db.query.resourceGifts.findMany({ where: eq(resourceGifts.projectId, projectId) });
}

// ── US-5.5 accept ───────────────────────────────────────────────────────────
export async function acceptResourceGift(actingUserId: string, giftId: string, db: Db = defaultDb): Promise<void> {
  await db.transaction(async (tx) => {
    const { gift } = await loadGiftAsCharityOwner(tx, actingUserId, giftId);
    const [row] = await tx
      .update(resourceGifts)
      .set({ status: 'accepted', decidedBy: actingUserId })
      .where(and(eq(resourceGifts.id, giftId), eq(resourceGifts.status, 'offered')))
      .returning({ id: resourceGifts.id });
    if (!row) throw new InvalidStateError(`Gift already ${gift.status}.`);
    // NOTE: intentionally no beginDelivery / deliveryWorkspaces — a gift is not delivery.
    await tx.insert(outbox).values({
      eventType: 'ResourceGiftAccepted',
      payload: { giftId, projectId: gift.projectId, corporationOrgId: gift.corporationOrgId },
    });
  });
}

// ── US-5.5 decline ──────────────────────────────────────────────────────────
export async function declineResourceGift(
  actingUserId: string,
  giftId: string,
  reason: string,
  db: Db = defaultDb,
): Promise<void> {
  if (!reason?.trim()) throw new InvalidStateError('A decline reason is required.');
  await db.transaction(async (tx) => {
    const { gift } = await loadGiftAsCharityOwner(tx, actingUserId, giftId);
    const [row] = await tx
      .update(resourceGifts)
      .set({ status: 'declined', decidedBy: actingUserId, reason: reason.trim() })
      .where(and(eq(resourceGifts.id, giftId), eq(resourceGifts.status, 'offered')))
      .returning({ id: resourceGifts.id });
    if (!row) throw new InvalidStateError(`Gift already ${gift.status}.`);
    await tx.insert(outbox).values({
      eventType: 'ResourceGiftDeclined',
      payload: { giftId, projectId: gift.projectId, corporationOrgId: gift.corporationOrgId, reason: reason.trim() },
    });
  });
}
```

- [ ] **Step 5: Export the gift API** — add to `src/modules/commitments/index.ts`:

```typescript
export {
  offerResourceGift,
  listResourceGiftsForProject,
  acceptResourceGift,
  declineResourceGift,
  resourceGiftSchema,
  type ResourceGiftInput,
} from './gifts';
```

- [ ] **Step 6: Run the test to verify it passes**

Run: `npm run test:integration -- src/modules/commitments/resource-gifts.integration.test.ts`
Expected: PASS (6 tests).

- [ ] **Step 7: Add the API routes.**

Create `src/app/api/projects/[id]/resource-gifts/route.ts`:

```typescript
import { NextResponse } from 'next/server';
import { offerResourceGift, listResourceGiftsForProject, resourceGiftSchema } from '@/modules/commitments';
import { requireUser } from '@/lib/auth';
import { readJson, errorResponse } from '@/lib/http';

export const dynamic = 'force-dynamic';

// US-5.5 — a CSR manager offers an in-kind resource gift to a published project.
export async function POST(req: Request, { params }: { params: Promise<{ id: string }> }) {
  try {
    const session = await requireUser();
    const { id } = await params;
    const input = resourceGiftSchema.parse(await readJson(req));
    const { giftId } = await offerResourceGift(session.userId, id, input);
    return NextResponse.json({ giftId, status: 'offered' }, { status: 201 });
  } catch (e) {
    return errorResponse(e);
  }
}

// US-5.5 — the charity_owner lists resource gifts on its project.
export async function GET(_req: Request, { params }: { params: Promise<{ id: string }> }) {
  try {
    const session = await requireUser();
    const { id } = await params;
    return NextResponse.json({ gifts: await listResourceGiftsForProject(session.userId, id) });
  } catch (e) {
    return errorResponse(e);
  }
}
```

Create `src/app/api/resource-gifts/[id]/accept/route.ts`:

```typescript
import { NextResponse } from 'next/server';
import { acceptResourceGift } from '@/modules/commitments';
import { requireUser } from '@/lib/auth';
import { errorResponse } from '@/lib/http';

// US-5.5 — charity_owner accepts a resource gift (no delivery is started).
export async function POST(_req: Request, { params }: { params: Promise<{ id: string }> }) {
  try {
    const session = await requireUser();
    const { id } = await params;
    await acceptResourceGift(session.userId, id);
    return NextResponse.json({ ok: true, status: 'accepted' });
  } catch (e) {
    return errorResponse(e);
  }
}
```

Create `src/app/api/resource-gifts/[id]/decline/route.ts`:

```typescript
import { NextResponse } from 'next/server';
import { z } from 'zod';
import { declineResourceGift } from '@/modules/commitments';
import { requireUser } from '@/lib/auth';
import { readJson, errorResponse } from '@/lib/http';

const schema = z.object({ reason: z.string().min(1).max(1000) });

// US-5.5 — charity_owner declines a resource gift with a reason.
export async function POST(req: Request, { params }: { params: Promise<{ id: string }> }) {
  try {
    const session = await requireUser();
    const { id } = await params;
    const { reason } = schema.parse(await readJson(req));
    await declineResourceGift(session.userId, id, reason);
    return NextResponse.json({ ok: true, status: 'declined' });
  } catch (e) {
    return errorResponse(e);
  }
}
```

- [ ] **Step 8: Typecheck, lint, commit**

Run: `npm run typecheck && npm run lint`
Expected: PASS.
```bash
git add src/modules/commitments/ src/app/api/projects/\[id\]/resource-gifts/ src/app/api/resource-gifts/
git commit -m "feat(commitments): offer/accept/decline in-kind resource gifts (US-5.5)"
```

---

### Task 4: Confirm provided → received, and withdraw (US-6.5, Should)

**Files:**
- Modify: `src/modules/commitments/gifts.ts` (add three functions)
- Modify: `src/modules/commitments/index.ts` (export them)
- Create: `src/app/api/resource-gifts/[id]/provided/route.ts`, `.../received/route.ts`, `.../withdraw/route.ts`
- Test: extend `src/modules/commitments/resource-gifts.integration.test.ts`

**Interfaces:**
- Consumes: everything from Task 3.
- Produces:
  - `markResourceGiftProvided(actingUserId, giftId, db?): Promise<void>` (csr_manager of the owning corp; `accepted → provided`)
  - `confirmResourceGiftReceived(actingUserId, giftId, db?): Promise<void>` (charity_owner; `provided → received`)
  - `withdrawResourceGift(actingUserId, giftId, reason, db?): Promise<void>` (csr_manager; `offered|accepted|provided → withdrawn`)

- [ ] **Step 1: Write the failing test** — append this `describe` block to `src/modules/commitments/resource-gifts.integration.test.ts` (import the three new functions from `./gifts` at the top):

```typescript
describe('Commitments — confirm & withdraw resource gifts (US-6.5)', () => {
  it('provided → received; provided vs received are distinct', async () => {
    const { charity, corp, projectId } = await scenario();
    const { giftId } = await offerResourceGift(corp.userId, projectId, gift(corp.organisationId), testDb);
    await acceptResourceGift(charity.userId, giftId, testDb);
    // cannot confirm before provided
    await expect(confirmResourceGiftReceived(charity.userId, giftId, testDb)).rejects.toBeInstanceOf(InvalidStateError);
    await markResourceGiftProvided(corp.userId, giftId, testDb);
    let row = await testDb.query.resourceGifts.findFirst({ where: eq(resourceGifts.id, giftId) });
    expect(row?.status).toBe('provided');
    expect(row?.providedAt).not.toBeNull();
    expect(row?.receivedAt).toBeNull(); // not yet confirmed
    await confirmResourceGiftReceived(charity.userId, giftId, testDb);
    row = await testDb.query.resourceGifts.findFirst({ where: eq(resourceGifts.id, giftId) });
    expect(row?.status).toBe('received');
    expect(row?.receivedAt).not.toBeNull();
  });

  it('corp can withdraw before received, not after', async () => {
    const { charity, corp, projectId } = await scenario();
    const { giftId } = await offerResourceGift(corp.userId, projectId, gift(corp.organisationId), testDb);
    await withdrawResourceGift(corp.userId, giftId, 'Budget reallocated', testDb);
    let row = await testDb.query.resourceGifts.findFirst({ where: eq(resourceGifts.id, giftId) });
    expect(row?.status).toBe('withdrawn');

    const second = await offerResourceGift(corp.userId, projectId, { ...gift(corp.organisationId), kind: 'domains' }, testDb);
    await acceptResourceGift(charity.userId, second.giftId, testDb);
    await markResourceGiftProvided(corp.userId, second.giftId, testDb);
    await confirmResourceGiftReceived(charity.userId, second.giftId, testDb);
    await expect(withdrawResourceGift(corp.userId, second.giftId, 'too late', testDb)).rejects.toBeInstanceOf(InvalidStateError);
  });
});
```

- [ ] **Step 2: Run it to verify it fails**

Run: `npm run test:integration -- src/modules/commitments/resource-gifts.integration.test.ts`
Expected: FAIL — `markResourceGiftProvided` / `confirmResourceGiftReceived` / `withdrawResourceGift` not defined.

- [ ] **Step 3: Add the three functions to `src/modules/commitments/gifts.ts`.** First add a corp-side loader below `loadGiftAsCharityOwner`:

```typescript
// A csr_manager acting on their corporation's own gift.
async function loadGiftAsCorpManager(exec: Executor, userId: string, giftId: string) {
  const g = await exec.query.resourceGifts.findFirst({ where: eq(resourceGifts.id, giftId) });
  if (!g) throw new NotFoundError('Resource gift');
  await assertCorpManager(exec, userId, g.corporationOrgId); // throws NotFound/Forbidden if not their corp
  return { gift: g };
}
```

Then the three transitions (all compare-and-set on `status`, all coordination-only):

```typescript
// ── US-6.5 corp marks provided ────────────────────────────────────────────────
export async function markResourceGiftProvided(actingUserId: string, giftId: string, db: Db = defaultDb): Promise<void> {
  await db.transaction(async (tx) => {
    const { gift } = await loadGiftAsCorpManager(tx, actingUserId, giftId);
    const [row] = await tx
      .update(resourceGifts)
      .set({ status: 'provided', providedAt: new Date() })
      .where(and(eq(resourceGifts.id, giftId), eq(resourceGifts.status, 'accepted')))
      .returning({ id: resourceGifts.id });
    if (!row) throw new InvalidStateError(`Gift cannot be marked provided from ${gift.status}.`);
    await tx.insert(outbox).values({
      eventType: 'ResourceGiftProvided',
      payload: { giftId, projectId: gift.projectId, corporationOrgId: gift.corporationOrgId },
    });
  });
}

// ── US-6.5 charity confirms receipt ───────────────────────────────────────────
export async function confirmResourceGiftReceived(actingUserId: string, giftId: string, db: Db = defaultDb): Promise<void> {
  await db.transaction(async (tx) => {
    const { gift } = await loadGiftAsCharityOwner(tx, actingUserId, giftId);
    const [row] = await tx
      .update(resourceGifts)
      .set({ status: 'received', receivedAt: new Date() })
      .where(and(eq(resourceGifts.id, giftId), eq(resourceGifts.status, 'provided')))
      .returning({ id: resourceGifts.id });
    if (!row) throw new InvalidStateError(`Gift cannot be confirmed from ${gift.status}.`);
    await tx.insert(outbox).values({
      eventType: 'ResourceGiftReceived',
      payload: { giftId, projectId: gift.projectId, corporationOrgId: gift.corporationOrgId },
    });
  });
}

// ── corp withdraws (any live state, never after received) ─────────────────────
export async function withdrawResourceGift(actingUserId: string, giftId: string, reason: string, db: Db = defaultDb): Promise<void> {
  if (!reason?.trim()) throw new InvalidStateError('A withdraw reason is required.');
  await db.transaction(async (tx) => {
    const { gift } = await loadGiftAsCorpManager(tx, actingUserId, giftId);
    const [row] = await tx
      .update(resourceGifts)
      .set({ status: 'withdrawn', reason: reason.trim() })
      .where(and(eq(resourceGifts.id, giftId), inArray(resourceGifts.status, [...LIVE_STATES])))
      .returning({ id: resourceGifts.id });
    if (!row) throw new InvalidStateError(`Gift cannot be withdrawn from ${gift.status}.`);
    await tx.insert(outbox).values({
      eventType: 'ResourceGiftWithdrawn',
      payload: { giftId, projectId: gift.projectId, corporationOrgId: gift.corporationOrgId, reason: reason.trim() },
    });
  });
}
```

- [ ] **Step 4: Export them** — add to the `./gifts` export block in `src/modules/commitments/index.ts`:

```typescript
  markResourceGiftProvided,
  confirmResourceGiftReceived,
  withdrawResourceGift,
```

- [ ] **Step 5: Run the test to verify it passes**

Run: `npm run test:integration -- src/modules/commitments/resource-gifts.integration.test.ts`
Expected: PASS (8 tests total).

- [ ] **Step 6: Add the three API routes** (same shape as accept; provided/received take no body, withdraw takes a reason).

Create `src/app/api/resource-gifts/[id]/provided/route.ts`:

```typescript
import { NextResponse } from 'next/server';
import { markResourceGiftProvided } from '@/modules/commitments';
import { requireUser } from '@/lib/auth';
import { errorResponse } from '@/lib/http';

// US-6.5 — the donating corporation marks a gift as provided.
export async function POST(_req: Request, { params }: { params: Promise<{ id: string }> }) {
  try {
    const session = await requireUser();
    const { id } = await params;
    await markResourceGiftProvided(session.userId, id);
    return NextResponse.json({ ok: true, status: 'provided' });
  } catch (e) {
    return errorResponse(e);
  }
}
```

Create `src/app/api/resource-gifts/[id]/received/route.ts`:

```typescript
import { NextResponse } from 'next/server';
import { confirmResourceGiftReceived } from '@/modules/commitments';
import { requireUser } from '@/lib/auth';
import { errorResponse } from '@/lib/http';

// US-6.5 — the charity confirms it received a gift.
export async function POST(_req: Request, { params }: { params: Promise<{ id: string }> }) {
  try {
    const session = await requireUser();
    const { id } = await params;
    await confirmResourceGiftReceived(session.userId, id);
    return NextResponse.json({ ok: true, status: 'received' });
  } catch (e) {
    return errorResponse(e);
  }
}
```

Create `src/app/api/resource-gifts/[id]/withdraw/route.ts`:

```typescript
import { NextResponse } from 'next/server';
import { z } from 'zod';
import { withdrawResourceGift } from '@/modules/commitments';
import { requireUser } from '@/lib/auth';
import { readJson, errorResponse } from '@/lib/http';

const schema = z.object({ reason: z.string().min(1).max(1000) });

// The donating corporation withdraws a gift (before it is received).
export async function POST(req: Request, { params }: { params: Promise<{ id: string }> }) {
  try {
    const session = await requireUser();
    const { id } = await params;
    const { reason } = schema.parse(await readJson(req));
    await withdrawResourceGift(session.userId, id, reason);
    return NextResponse.json({ ok: true, status: 'withdrawn' });
  } catch (e) {
    return errorResponse(e);
  }
}
```

- [ ] **Step 7: Typecheck, lint, commit**

Run: `npm run typecheck && npm run lint`
Expected: PASS.
```bash
git add src/modules/commitments/ src/app/api/resource-gifts/
git commit -m "feat(commitments): confirm provided/received + withdraw resource gifts (US-6.5)"
```

---

### Task 5: Notifications — dispatch ResourceGift* events

**Files:**
- Modify: `src/modules/notifications/service.ts` (add cases to `dispatchEvent`)
- Modify: `src/app/notifications/page.tsx` (add COPY entries for the ravens inbox)
- Test: extend `src/modules/commitments/resource-gifts.integration.test.ts` with a relay assertion

**Interfaces:**
- Consumes: `relayOutbox` (from `@/modules/notifications`), the outbox events emitted in Tasks 3–4.
- Produces: notification `type` strings `resource_gift.offered`, `resource_gift.accepted`, `resource_gift.declined`, `resource_gift.provided`, `resource_gift.received`.

- [ ] **Step 1: Write the failing test** — append to `src/modules/commitments/resource-gifts.integration.test.ts` (add `relayOutbox` + `listForUser` imports from `@/modules/notifications`, and `findOrgMemberByRole` from `@/modules/identity`, OR resolve the charity owner via the charity userId returned by `registerCharity`, which IS the charity_owner):

```typescript
import { relayOutbox, listForUser } from '@/modules/notifications';

describe('Notifications — resource gifts (US-8.1)', () => {
  it('an offered gift notifies the charity owner; acceptance notifies the CSR manager', async () => {
    const { charity, corp, projectId } = await scenario();
    const { giftId } = await offerResourceGift(corp.userId, projectId, gift(corp.organisationId), testDb);
    await relayOutbox(testDb);
    const charityNotes = await listForUser(charity.userId, testDb);
    expect(charityNotes.some((n) => n.type === 'resource_gift.offered')).toBe(true);

    await acceptResourceGift(charity.userId, giftId, testDb);
    await relayOutbox(testDb);
    const corpNotes = await listForUser(corp.userId, testDb);
    expect(corpNotes.some((n) => n.type === 'resource_gift.accepted')).toBe(true);
  });
});
```

- [ ] **Step 2: Run it to verify it fails**

Run: `npm run test:integration -- src/modules/commitments/resource-gifts.integration.test.ts`
Expected: FAIL — no `resource_gift.offered` notification (the event currently falls through `default`).

- [ ] **Step 3: Add the cases** to `dispatchEvent` in `src/modules/notifications/service.ts`, before the `default:` branch:

```typescript
    case 'ResourceGiftOffered':
    case 'ResourceGiftProvided': {
      const charityOrg = await charityOrgOf(exec, p.projectId as string);
      if (charityOrg) {
        const owner = await orgMember(exec, charityOrg, 'charity_owner');
        await create(
          exec,
          owner,
          event.eventType === 'ResourceGiftOffered' ? 'resource_gift.offered' : 'resource_gift.provided',
          p,
        );
      }
      break;
    }
    case 'ResourceGiftAccepted':
    case 'ResourceGiftDeclined':
    case 'ResourceGiftReceived': {
      const csr = await orgMember(exec, p.corporationOrgId as string, 'csr_manager');
      const type =
        event.eventType === 'ResourceGiftAccepted'
          ? 'resource_gift.accepted'
          : event.eventType === 'ResourceGiftDeclined'
            ? 'resource_gift.declined'
            : 'resource_gift.received';
      await create(exec, csr, type, p);
      break;
    }
```

(`ResourceGiftWithdrawn` intentionally produces no notification — the charity took no action on it; it falls through `default`.)

- [ ] **Step 4: Run the test to verify it passes**

Run: `npm run test:integration -- src/modules/commitments/resource-gifts.integration.test.ts`
Expected: PASS.

- [ ] **Step 5: Add human-readable copy to the ravens inbox** — in `src/app/notifications/page.tsx`, add these entries to the `COPY` map:

```typescript
  'resource_gift.offered': {
    title: 'A company offered a resource gift',
    body: () => 'A corporation has offered to donate a digital resource to one of your projects.',
  },
  'resource_gift.accepted': {
    title: 'Your resource gift was accepted',
    body: () => 'The charity accepted your in-kind resource gift.',
  },
  'resource_gift.declined': {
    title: 'Your resource gift was declined',
    body: (p) => reasonOf(p, 'The charity has declined this resource gift.'),
  },
  'resource_gift.provided': {
    title: 'A resource gift was marked provided',
    body: () => 'A donor marked a resource gift as provided — confirm when you receive it.',
  },
  'resource_gift.received': {
    title: 'Your resource gift was confirmed received',
    body: () => 'The charity confirmed it received your in-kind resource gift.',
  },
```

- [ ] **Step 6: Typecheck, lint, commit**

Run: `npm run typecheck && npm run lint`
Expected: PASS.
```bash
git add src/modules/notifications/service.ts src/app/notifications/page.tsx src/modules/commitments/resource-gifts.integration.test.ts
git commit -m "feat(notifications): ravens for resource-gift events (US-8.1)"
```

---

### Task 6: US-RG guardrail — merit-blind, marketplace-neutral, structural boundary + docs

**Files:**
- Test: `src/modules/engagement/resource-gift-integrity.integration.test.ts` (merit-blindness)
- Test: `src/modules/scoring-boundary.test.ts` (unit: closed source allowlist + no gift import)
- Modify: `ARCHITECTURE.md` (§8 correction + resource-gift note)
- Modify: `PRODUCT_BACKLOG.md` (add US-2.7, US-5.5, US-6.5, US-RG)

**Interfaces:**
- Consumes: `offerResourceGift`/`acceptResourceGift`/`markResourceGiftProvided`/`confirmResourceGiftReceived` (Tasks 3–4); `listProjects` (Discovery); `recomputeProjectScore` or the scoring recompute entrypoint in `@/modules/engagement`; `projectScores` table.

- [ ] **Step 1: Write the merit-blindness integration test** — create `src/modules/engagement/resource-gift-integrity.integration.test.ts`. Confirm the exact recompute export name first: run `grep -n "export" src/modules/engagement/index.ts` and use the score recompute / support entrypoint (e.g. `supportProject` to seed a non-zero baseline, and read `project_scores` directly).

```typescript
import { describe, it, expect } from 'vitest';
import { eq } from 'drizzle-orm';
import { testDb } from '@/test/db';
import { projectScores } from '@/db/schema';
import { registerCharity, registerCorporation, approveVerification, createPlatformAdmin } from '@/modules/identity';
import { createDraftProject, setResourceNeeds, publishProject } from '@/modules/projects';
import { supportProject } from '@/modules/engagement';
import { listProjects } from '@/modules/discovery';
import {
  offerResourceGift,
  acceptResourceGift,
  markResourceGiftProvided,
  confirmResourceGiftReceived,
} from '@/modules/commitments';

const need = { skill: 'Backend', role: 'Backend dev', kind: 'ongoing' as const, quantity: 1, hoursPerWeek: 2, durationWeeks: 8 };

async function setup() {
  const admin = await createPlatformAdmin('admin@hh.com', 'admin-password-1', testDb);
  const charity = await registerCharity(
    { email: 'petra@goodcause.org', password: 'a-strong-password', charityName: 'Good Cause', regNumber: 'CH-1' },
    testDb,
  );
  await approveVerification(charity.verificationRequestId, admin, testDb);
  const corp = await registerCorporation(
    { email: 'carlos@acme.com', password: 'a-strong-password', companyName: 'Acme', emailDomain: 'acme.com' },
    testDb,
  );
  await approveVerification(corp.verificationRequestId, admin, testDb);
  const { projectId } = await createDraftProject(
    charity.userId,
    { charityOrgId: charity.organisationId, title: 'Rebuild the community garden', description: 'A worthy cause that needs a hand.', goal: 'Reach the finish line.', category: 'software' },
    testDb,
  );
  await setResourceNeeds(charity.userId, projectId, [need], testDb);
  await publishProject(charity.userId, projectId, testDb);
  return { charity, corp, projectId };
}

describe('US-RG — resource gifts are merit-blind and marketplace-neutral', () => {
  it('offering→accepting→providing→receiving a gift never changes the score or rank', async () => {
    const { charity, corp, projectId } = await setup();
    const supporter = await createPlatformAdmin('fan@x.com', 'password-1234', testDb);
    await supportProject(supporter, projectId, testDb); // establish a real baseline score

    const before = await testDb.query.projectScores.findFirst({ where: eq(projectScores.projectId, projectId) });
    const rankBefore = (await listProjects({ sort: 'support' }, testDb)).map((r) => r.id);

    const { giftId } = await offerResourceGift(
      corp.userId, projectId,
      { corporationOrgId: corp.organisationId, kind: 'cloud_credits', quantity: 100000, unit: 'USD credits' },
      testDb,
    );
    await acceptResourceGift(charity.userId, giftId, testDb);
    await markResourceGiftProvided(corp.userId, giftId, testDb);
    await confirmResourceGiftReceived(charity.userId, giftId, testDb);

    const after = await testDb.query.projectScores.findFirst({ where: eq(projectScores.projectId, projectId) });
    expect(after?.rawR).toBe(before?.rawR);
    expect(after?.supportScore).toBe(before?.supportScore);
    expect(after?.momentumScore).toBe(before?.momentumScore);

    const rankAfter = (await listProjects({ sort: 'support' }, testDb)).map((r) => r.id);
    expect(rankAfter).toEqual(rankBefore);
  });
});
```

- [ ] **Step 2: Run it to verify it passes immediately** (this is the structural guarantee — it should pass with no production change):

Run: `npm run test:integration -- src/modules/engagement/resource-gift-integrity.integration.test.ts`
Expected: PASS. If it FAILS, a real leak exists (a gift reached scoring/discovery) — stop and fix the leak before continuing.

- [ ] **Step 3: Write the structural boundary unit test** — create `src/modules/scoring-boundary.test.ts`. It reads the scoring/discovery source and asserts they never reference the gifts table, and that the engagement source set stays closed:

```typescript
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';

const read = (p: string) => readFileSync(p, 'utf8');

describe('merit-integrity boundary (US-RG, structural)', () => {
  it('scoring/discovery source never references resource gifts', () => {
    for (const f of ['src/modules/engagement/service.ts', 'src/modules/discovery/service.ts']) {
      const src = read(f);
      expect(src).not.toMatch(/resourceGifts|resource_gifts/);
    }
  });

  it('the scoring engagement-source allowlist is closed to on_platform/facebook/twitter', () => {
    const src = read('src/modules/engagement/service.ts');
    // Any newly-introduced source string must be a deliberate, reviewed change.
    const sources = [...src.matchAll(/'(on_platform|facebook|twitter|instagram|tiktok|linkedin|youtube)'/g)].map((m) => m[1]);
    const unexpected = sources.filter((s) => !['on_platform', 'facebook', 'twitter'].includes(s!));
    expect(unexpected).toEqual([]);
  });
});
```

- [ ] **Step 4: Run the boundary test**

Run: `npm run test -- src/modules/scoring-boundary.test.ts`
Expected: PASS. (If the source-file paths differ, adjust to the actual scoring source location — confirm with `grep -rl "recomputeProjectScore\|computeScores" src/modules`.)

- [ ] **Step 5: Add the merit-integrity boundary rule to the modules README** — append to `src/modules/README.md` under the boundary rules:

```markdown
- **Resource gifts are merit-blind (US-RG).** `resource_gifts` is a Commitments
  table. `scoring`/`engagement` and `discovery` must never read it or import from
  Commitments; a gift (offered/accepted/provided/received) is never an input to
  `project_scores` or to any discovery ORDER BY/filter, and never places donor
  branding on the neutral marketplace. Enforced by `scoring-boundary.test.ts` and
  `engagement/resource-gift-integrity.integration.test.ts`.
```

- [ ] **Step 6: Fix the ARCHITECTURE §8 doc-hygiene discrepancy.** In `ARCHITECTURE.md` §8, correct the claim that Scoring subscribes to the outbox. Replace the relevant sentence with wording matching the actual code, e.g.:

```markdown
Scoring is **not** an outbox subscriber. It is a pure library
(`engagement/service.ts`) invoked **synchronously, in-transaction** by
`recomputeProjectScore` over `on_platform_supports` and confirmed
`engagement_events` only. The outbox relay dispatches domain events to
**Notifications**. This is why in-kind resource gifts (US-RG) cannot reach the
score: there is no bus a gift event could ride to Scoring.
```

Also add a one-line note under the Commitments context describing `resource_gifts` as a sibling aggregate (offer→accept/decline→provided→received, coordination-only, no delivery workspace).

- [ ] **Step 7: Add the stories to the backlog.** In `PRODUCT_BACKLOG.md`, add **US-2.7** (Epic 2), **US-5.5** (Epic 5), **US-6.5** (Epic 6), and **US-RG** (Epic 10, noting it extends the payment-blind guardrail — reconcile the exact number against the existing integrity story in that epic). Use the story text from the spec §7 as the source.

- [ ] **Step 8: Full verify gate + commit**

Run: `npm run typecheck && npm run lint && npm run test && npm run test:integration && npm run format:check`
Expected: all PASS (unit incl. the new boundary test; integration incl. all resource-gift + integrity tests).
```bash
git add src/modules/engagement/resource-gift-integrity.integration.test.ts src/modules/scoring-boundary.test.ts src/modules/README.md ARCHITECTURE.md PRODUCT_BACKLOG.md
git commit -m "test(integrity): resource gifts are merit-blind (US-RG) + doc-hygiene"
```

---

## Self-Review

**Spec coverage:**
- §7 US-2.7 (declare digital-resource need) → Task 2 ✓
- §7 US-5.5 (offer + accept/decline) → Task 3 ✓
- §7 US-6.5 (provided → received, Should) → Task 4 ✓ (+ withdraw from §10)
- §7 US-RG (merit-blind, neutral) → Task 6 ✓
- §5 data model (two sibling tables, enums, divergences from pledges) → Task 1 ✓
- §6 events + structural seam (Notifications only, Scoring not subscribed) → Tasks 3–5 emit; Task 6 asserts structurally ✓
- §10 failure modes: dedupe (Task 3), status CAS (Tasks 3–4), provided-vs-received distinct (Task 4), decline/withdraw reasons (Tasks 3–4), verified-actor gates (Tasks 3–4), provided-but-unconfirmed labelled — surfaced via the read model + ravens copy (Tasks 2, 5); rate-limiting deferred as a non-blocking tuning item (spec §8.6) — **not implemented here**, matching the spec's "not blocking" classification.
- §12 ARCHITECTURE §8 doc-hygiene → Task 6 Step 6 ✓
- §13 backlog + architecture notes → Task 6 Steps 6–7 ✓

**Placeholder scan:** No TBD/TODO; every code step shows complete code; every test step shows the assertions. Two explicit "confirm the exact name with grep" notes (Task 6 Steps 1, 4) are guarded verification steps, not placeholders — the scoring recompute entrypoint lives in `@/modules/engagement` and the exact export must be read from the code at execution time.

**Type consistency:** `DIGITAL_RESOURCE_KINDS` (Projects) is the single kind source, imported by both `digitalResourceNeedSchema` (Task 2) and `resourceGiftSchema` (Task 3). `assertCorpManager` is exported once (Task 3 Step 1) and reused. Status strings (`offered/accepted/declined/provided/received/withdrawn`) and event names (`ResourceGift*`) match across Tasks 3–6. Notification `type` strings (`resource_gift.*`) match between the dispatcher (Task 5 Step 3) and the ravens COPY map (Task 5 Step 5).

**Scope:** One coherent vertical (needs → gift lifecycle → notifications → integrity) in the Projects + Commitments + Notifications modules. Front-end forms are explicitly a separate follow-up plan.
