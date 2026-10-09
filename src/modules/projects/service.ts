import { and, eq, inArray, sql } from 'drizzle-orm';
import { z } from 'zod';
import { db as defaultDb } from '@/db';
import { projects, projectResourceNeeds, digitalResourceNeeds, outbox } from '@/db/schema';
import {
  assertOrganisationVerified,
  findMembership,
  NotFoundError,
  InvalidStateError,
  ForbiddenError,
} from '@/modules/identity';
import {
  InvalidProjectTransitionError,
  ProjectValidationError,
  NoResourceNeedsError,
} from './errors';

/**
 * Projects service — US-2.1 (create), US-2.2 (resource needs), US-2.4 (lifecycle).
 * Mirrors the Identity module conventions: injected `db`, zod schemas, typed
 * errors, transactional writes with same-transaction outbox events. Writes only
 * to `projects` / `project_resource_needs`; the publish gate calls Identity's
 * public `assertOrganisationVerified` rather than touching its tables.
 */
type Db = typeof defaultDb;
type Tx = Parameters<Parameters<Db['transaction']>[0]>[0];
type Executor = Db | Tx;

export type ProjectStatus = 'draft' | 'published' | 'in_delivery' | 'completed' | 'archived';

// ── Lifecycle (US-2.4) ───────────────────────────────────────────────────────
const LEGAL: Record<ProjectStatus, ProjectStatus[]> = {
  draft: ['published', 'archived'],
  published: ['in_delivery', 'archived'],
  in_delivery: ['published', 'completed'],
  completed: ['archived'],
  archived: [],
};

/** Pure transition-legality check (unit-tested). Self-transitions are illegal. */
export function isTransitionAllowed(from: ProjectStatus, to: ProjectStatus): boolean {
  return from !== to && LEGAL[from].includes(to);
}

const PUBLIC_STATES: ProjectStatus[] = ['published', 'in_delivery', 'completed'];
const EDITABLE_STATES: ProjectStatus[] = ['draft', 'published'];

// US-2.6 controlled category taxonomy (admin-extensible later).
export const PROJECT_CATEGORIES = [
  'software',
  'design',
  'construction',
  'marketing',
  'fundraising',
  'events',
  'research',
  'legal',
  'operations',
] as const;
export type ProjectCategory = (typeof PROJECT_CATEGORIES)[number];

// ── Schemas ──────────────────────────────────────────────────────────────────
export const resourceNeedSchema = z.object({
  skill: z.string().trim().min(2).max(80),
  role: z.string().trim().min(2).max(80),
  kind: z.enum(['ongoing', 'sprint']),
  quantity: z.number().int().min(1).max(999).default(1),
  hoursPerWeek: z.number().int().min(1).max(40),
  durationWeeks: z.number().int().min(1).max(104),
});
export type ResourceNeedInput = z.infer<typeof resourceNeedSchema>;

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

export const createProjectSchema = z.object({
  charityOrgId: z.string().uuid(),
  title: z.string().trim().min(4).max(120),
  description: z.string().trim().min(20).max(5000).optional(),
  goal: z.string().trim().min(10).max(1000).optional(),
  category: z.enum(PROJECT_CATEGORIES).optional(),
});
export type CreateProjectInput = z.infer<typeof createProjectSchema>;

export const updateDraftSchema = z.object({
  title: z.string().trim().min(4).max(120).optional(),
  description: z.string().trim().min(20).max(5000).optional(),
  goal: z.string().trim().min(10).max(1000).optional(),
  category: z.enum(PROJECT_CATEGORIES).optional(),
});
export type UpdateDraftInput = z.infer<typeof updateDraftSchema>;

// ── Authorization: load a project the acting user owns as charity_owner ──────
// Cross-tenant (no membership) → NotFound (don't leak existence); wrong role → Forbidden.
async function loadOwnedProject(tx: Executor, actingUserId: string, projectId: string) {
  const project = await tx.query.projects.findFirst({ where: eq(projects.id, projectId) });
  if (!project) throw new NotFoundError('Project');
  const membership = await findMembership(actingUserId, project.charityOrgId, tx);
  if (!membership) throw new NotFoundError('Project');
  if (membership.role !== 'charity_owner') throw new ForbiddenError();
  return project;
}

// ── US-2.1 create / edit draft ───────────────────────────────────────────────
export async function createDraftProject(
  actingUserId: string,
  input: CreateProjectInput,
  db: Db = defaultDb,
): Promise<{ projectId: string }> {
  const v = createProjectSchema.parse(input);
  const membership = await findMembership(actingUserId, v.charityOrgId, db);
  if (!membership) throw new NotFoundError('Organisation');
  if (membership.role !== 'charity_owner') throw new ForbiddenError();

  const [row] = await db
    .insert(projects)
    .values({
      charityOrgId: v.charityOrgId,
      title: v.title,
      description: v.description ?? null,
      goal: v.goal ?? null,
      category: v.category ?? null,
      status: 'draft',
    })
    .returning({ id: projects.id });
  return { projectId: row!.id };
}

export async function updateDraftProject(
  actingUserId: string,
  projectId: string,
  input: UpdateDraftInput,
  db: Db = defaultDb,
): Promise<void> {
  const v = updateDraftSchema.parse(input);
  await db.transaction(async (tx) => {
    const project = await loadOwnedProject(tx, actingUserId, projectId);
    if (project.status !== 'draft') {
      throw new InvalidStateError('Only draft projects can be edited.');
    }
    await tx
      .update(projects)
      .set({ ...v, updatedAt: sql`now()` })
      .where(eq(projects.id, projectId));
  });
}

// ── US-2.2 resource needs (replace-all) ──────────────────────────────────────
export async function setResourceNeeds(
  actingUserId: string,
  projectId: string,
  needs: ResourceNeedInput[],
  db: Db = defaultDb,
): Promise<void> {
  const parsed = needs.map((n) => resourceNeedSchema.parse(n));
  await db.transaction(async (tx) => {
    const project = await loadOwnedProject(tx, actingUserId, projectId);
    if (!EDITABLE_STATES.includes(project.status)) {
      throw new InvalidStateError(
        'Resource needs can only be changed on draft or published projects.',
      );
    }
    // A published project must always keep ≥1 need (US-2.2 AC-2.2.6).
    if (project.status === 'published' && parsed.length === 0) throw new NoResourceNeedsError();

    await tx.delete(projectResourceNeeds).where(eq(projectResourceNeeds.projectId, projectId));
    if (parsed.length > 0) {
      await tx.insert(projectResourceNeeds).values(parsed.map((n) => ({ ...n, projectId })));
    }
    await tx
      .update(projects)
      .set({ updatedAt: sql`now()` })
      .where(eq(projects.id, projectId));
    if (project.status === 'published') {
      await tx.insert(outbox).values({ eventType: 'ProjectUpdated', payload: { projectId } });
    }
  });
}

// ── US-2.7 digital-resource needs (replace-all; no monetary value) ──────────
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
      throw new InvalidStateError(
        'Resource needs can only be changed on draft or published projects.',
      );
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
    await tx
      .update(projects)
      .set({ updatedAt: sql`now()` })
      .where(eq(projects.id, projectId));
  });
}

// ── US-2.1 publish / US-2.4 transitions ──────────────────────────────────────
export function publishProject(
  actingUserId: string,
  projectId: string,
  db: Db = defaultDb,
): Promise<void> {
  return transitionProjectStatus(actingUserId, projectId, 'published', db);
}

export async function transitionProjectStatus(
  actingUserId: string,
  projectId: string,
  to: ProjectStatus,
  db: Db = defaultDb,
): Promise<void> {
  await db.transaction(async (tx) => {
    const project = await loadOwnedProject(tx, actingUserId, projectId);
    const from = project.status as ProjectStatus;
    if (!isTransitionAllowed(from, to)) throw new InvalidProjectTransitionError(from, to);
    // US-7.3 — completion produces content (the outcome story), so it has its
    // own operation. Refusing it here keeps ONE way to reach 'completed': a
    // status-only path would let a project complete with no result to show.
    if (to === 'completed')
      throw new InvalidStateError('Use completeProject to complete a project with its outcome.');

    if (to === 'published') {
      await assertOrganisationVerified(project.charityOrgId, tx);
      const missing: string[] = [];
      if (!project.description || project.description.trim().length < 20)
        missing.push('description');
      if (!project.goal || project.goal.trim().length < 10) missing.push('goal');
      if (!project.category) missing.push('category'); // US-2.6: category required at publish
      if (missing.length > 0) throw new ProjectValidationError(missing);
      const needs = await tx.query.projectResourceNeeds.findMany({
        where: eq(projectResourceNeeds.projectId, projectId),
      });
      if (needs.length === 0) throw new NoResourceNeedsError();
    }

    // First publish only — reopen (in_delivery→published) must NOT reset the
    // original publish time or re-fire the first-publish event.
    const isFirstPublish = to === 'published' && from === 'draft';

    // Compare-and-set on status closes the read-then-write race (concurrent transitions).
    const [row] = await tx
      .update(projects)
      .set({
        status: to,
        updatedAt: sql`now()`,
        ...(isFirstPublish ? { publishedAt: sql`now()` } : {}),
      })
      .where(and(eq(projects.id, projectId), eq(projects.status, from)))
      .returning({ id: projects.id });
    if (!row) throw new InvalidProjectTransitionError(from, to);

    await tx.insert(outbox).values({
      eventType: 'ProjectStatusChanged',
      payload: { projectId, from, to, charityOrgId: project.charityOrgId },
    });
    if (isFirstPublish) {
      await tx.insert(outbox).values({
        eventType: 'ProjectPublished',
        payload: { projectId, charityOrgId: project.charityOrgId, title: project.title },
      });
    }
  });
}

/** Minimum length for an outcome story — enough to actually say what happened. */
const OUTCOME_STORY_MIN = 30;

/** Route body for completion (US-7.3). */
export const completeProjectSchema = z.object({
  outcomeStory: z.string().min(OUTCOME_STORY_MIN).max(5000),
});
export type CompleteProjectInput = z.infer<typeof completeProjectSchema>;

/**
 * US-7.3 — the charity marks a project complete WITH its outcome story. The
 * story is required: "completed" with nothing to show is what this story
 * exists to prevent, so validation happens before the status moves.
 *
 * `completedAt` is set only here, so the in_delivery -> published reopen path
 * can never reset it (the same rule publishedAt follows for first publish).
 */
export async function completeProject(
  actingUserId: string,
  projectId: string,
  outcomeStory: string,
  db: Db = defaultDb,
): Promise<void> {
  await db.transaction(async (tx) => {
    const project = await loadOwnedProject(tx, actingUserId, projectId);
    const from = project.status as ProjectStatus;
    if (!isTransitionAllowed(from, 'completed'))
      throw new InvalidProjectTransitionError(from, 'completed');

    const story = outcomeStory.trim();
    if (story.length < OUTCOME_STORY_MIN) throw new ProjectValidationError(['outcomeStory']);

    // Compare-and-set on status closes the concurrent-completion race.
    const [row] = await tx
      .update(projects)
      .set({
        status: 'completed',
        outcomeStory: story,
        completedAt: sql`now()`,
        updatedAt: sql`now()`,
      })
      .where(and(eq(projects.id, projectId), eq(projects.status, from)))
      .returning({ id: projects.id });
    if (!row) throw new InvalidProjectTransitionError(from, 'completed');

    await tx.insert(outbox).values({
      eventType: 'ProjectStatusChanged',
      payload: { projectId, from, to: 'completed', charityOrgId: project.charityOrgId },
    });
    // Emitted before any consumer exists, so supporter/corporation fan-out
    // (US-4.4, US-8.x) is additive later - as RunClosed was before Billing.
    await tx.insert(outbox).values({
      eventType: 'ProjectCompleted',
      payload: {
        projectId,
        charityOrgId: project.charityOrgId,
        title: project.title,
        outcomeStory: story,
      },
    });
  });
}

// ── Reads ────────────────────────────────────────────────────────────────────
export async function getProjectForOwner(
  actingUserId: string,
  projectId: string,
  db: Db = defaultDb,
) {
  const project = await loadOwnedProject(db, actingUserId, projectId);
  const needs = await db.query.projectResourceNeeds.findMany({
    where: eq(projectResourceNeeds.projectId, projectId),
  });
  const digital = await db.query.digitalResourceNeeds.findMany({
    where: eq(digitalResourceNeeds.projectId, projectId),
  });
  return { ...project, resourceNeeds: needs, digitalResourceNeeds: digital };
}

/**
 * Cross-module reference to a project (id, owning charity, status, title),
 * regardless of visibility state. Siblings (e.g. Commitments) use this to
 * authorize actions and read the owning org — never by querying `projects`.
 */
export async function getProjectRef(projectId: string, exec: Executor = defaultDb) {
  const p = await exec.query.projects.findFirst({
    where: eq(projects.id, projectId),
    // `category` is read by Commitments for the US-11.12 template allow-list;
    // `goal` by Delivery, so US-6.4 progress is read against the stated goal.
    columns: {
      id: true,
      charityOrgId: true,
      status: true,
      title: true,
      category: true,
      goal: true,
    },
  });
  return p ?? null;
}

/**
 * Transition a project published → in_delivery as the effect of an accepted
 * pledge (US-5.3). Intended to be called INSIDE the caller's transaction after
 * the caller has authorized the charity_owner — hence no ownership check here.
 * The compare-and-set makes it safe against concurrent accepts.
 */
export async function beginDelivery(projectId: string, exec: Executor = defaultDb): Promise<void> {
  const project = await exec.query.projects.findFirst({ where: eq(projects.id, projectId) });
  if (!project) throw new NotFoundError('Project');
  const from = project.status as ProjectStatus;
  if (!isTransitionAllowed(from, 'in_delivery')) {
    throw new InvalidProjectTransitionError(from, 'in_delivery');
  }
  const [row] = await exec
    .update(projects)
    .set({ status: 'in_delivery', updatedAt: sql`now()` })
    .where(and(eq(projects.id, projectId), eq(projects.status, from)))
    .returning({ id: projects.id });
  if (!row) throw new InvalidProjectTransitionError(from, 'in_delivery');
  await exec.insert(outbox).values({
    eventType: 'ProjectStatusChanged',
    payload: { projectId, from, to: 'in_delivery', charityOrgId: project.charityOrgId },
  });
}

/**
 * Admin/moderation removal (US-9.1): force a project to `archived` from any state,
 * no ownership check (the caller — Moderation — has authorized a platform admin).
 * Idempotent. Emits ProjectRemovedByAdmin.
 */
export async function archiveByAdmin(projectId: string, exec: Executor = defaultDb): Promise<void> {
  const project = await exec.query.projects.findFirst({ where: eq(projects.id, projectId) });
  if (!project) throw new NotFoundError('Project');
  if (project.status === 'archived') return;
  await exec
    .update(projects)
    .set({ status: 'archived', updatedAt: sql`now()` })
    .where(eq(projects.id, projectId));
  await exec.insert(outbox).values({
    eventType: 'ProjectRemovedByAdmin',
    payload: { projectId, from: project.status, charityOrgId: project.charityOrgId },
  });
}

/** Public read — only publicly-visible states (US-2.4 AC-2.4.7); else null. */
export async function getPublishedProject(projectId: string, db: Db = defaultDb) {
  const project = await db.query.projects.findFirst({ where: eq(projects.id, projectId) });
  if (!project || !PUBLIC_STATES.includes(project.status as ProjectStatus)) return null;
  const needs = await db.query.projectResourceNeeds.findMany({
    where: eq(projectResourceNeeds.projectId, projectId),
  });
  const digital = await db.query.digitalResourceNeeds.findMany({
    where: eq(digitalResourceNeeds.projectId, projectId),
  });
  return { ...project, resourceNeeds: needs, digitalResourceNeeds: digital };
}

/**
 * US-7.1 — headline facts about a set of projects, for a corporation's CSR
 * dashboard. Deliberately narrow: title, status and the published outcome, all
 * of which are already public on the project page. The caller supplies the ids
 * it is entitled to (the projects it pledged to), so this adds no authorisation
 * of its own - it is the cross-module reference read, like getProjectRef.
 */
export async function getProjectSummaries(projectIds: string[], exec: Executor = defaultDb) {
  if (projectIds.length === 0) return [];
  return exec.query.projects.findMany({
    where: inArray(projects.id, projectIds),
    columns: {
      id: true,
      title: true,
      status: true,
      outcomeStory: true,
      completedAt: true,
      charityOrgId: true,
    },
  });
}
