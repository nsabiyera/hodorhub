import { and, asc, eq, inArray } from 'drizzle-orm';
import { z } from 'zod';
import { db as defaultDb } from '@/db';
import {
  allocations,
  deliveryMilestones,
  deliveryTasks,
  deliveryWorkspaces,
  hourLogs,
  outbox,
} from '@/db/schema';
import {
  findMembership,
  listMembers,
  NotFoundError,
  ForbiddenError,
  InvalidStateError,
} from '@/modules/identity';
import { getPledgeRef } from '@/modules/commitments';
import { getProjectRef } from '@/modules/projects';

/**
 * Delivery workspace — US-6.3 (shared tasks & milestones) and US-6.4 (progress
 * against the project's goal). Sibling of `service.ts`, which owns allocations
 * and hour logs on the same workspace.
 *
 * The locked invariant, and the reason milestones live here: **only the charity
 * confirms a milestone**. The corporation delivers the work and moves the
 * tasks; it never declares its own delivery achieved. That is the same rule as
 * pending-vs-approved hours (US-6.2a) and provided-vs-received gifts (US-6.5).
 * "Every task is done" is therefore *derived* at read time (`readyToConfirm`),
 * never stored — nothing promotes itself.
 */
type Db = typeof defaultDb;
type Tx = Parameters<Parameters<Db['transaction']>[0]>[0];
type Executor = Db | Tx;

export const milestoneSchema = z.object({
  title: z.string().trim().min(3).max(200),
  // A plain calendar date: "late" is a day, not an instant, and a due date is
  // agreed between two organisations that need not share a timezone.
  dueOn: z
    .string()
    .regex(/^\d{4}-\d{2}-\d{2}$/, 'dueOn must be an ISO date (YYYY-MM-DD).')
    .optional(),
});

export const taskSchema = z.object({
  title: z.string().trim().min(3).max(200),
  detail: z.string().trim().max(2000).optional(),
  milestoneId: z.string().uuid().optional(),
  assignedAllocationId: z.string().uuid().optional(),
});

export const updateTaskSchema = z
  .object({
    status: z.enum(['todo', 'in_progress', 'done']).optional(),
    // `null` is a deliberate value here — it unassigns. `undefined` leaves it be.
    assignedAllocationId: z.string().uuid().nullable().optional(),
  })
  .refine((v) => v.status !== undefined || v.assignedAllocationId !== undefined, {
    message: 'Nothing to change.',
  });

export type MilestoneInput = z.infer<typeof milestoneSchema>;
export type TaskInput = z.infer<typeof taskSchema>;
export type UpdateTaskInput = z.infer<typeof updateTaskSchema>;

// ── Participation ──────────────────────────────────────────────────────────────

/**
 * Who is asking, and in what capacity. A workspace has exactly two
 * organisations: the charity that owns the project and the corporation whose
 * pledge was accepted. Anyone else — a platform admin included — gets a 404
 * rather than a 403, so a stranger cannot learn that the workspace exists.
 */
interface Participant {
  workspaceId: string;
  projectId: string;
  charityOrgId: string;
  corporationOrgId: string;
  side: 'charity' | 'corporation';
  isCharityOwner: boolean;
  isCsrManager: boolean;
  /** This actor's own allocations on this workspace (empty unless allocated). */
  allocationIds: string[];
}

async function loadParticipant(
  exec: Executor,
  userId: string,
  workspaceId: string,
): Promise<Participant> {
  const ws = await exec.query.deliveryWorkspaces.findFirst({
    where: eq(deliveryWorkspaces.id, workspaceId),
  });
  if (!ws) throw new NotFoundError('Delivery workspace');
  const pledge = await getPledgeRef(ws.pledgeId, exec);
  const project = await getProjectRef(ws.projectId, exec);
  if (!pledge || !project) throw new NotFoundError('Delivery workspace');

  const charityMembership = await findMembership(userId, project.charityOrgId, exec);
  const corpMembership = charityMembership
    ? null
    : await findMembership(userId, pledge.corporationOrgId, exec);
  if (!charityMembership && !corpMembership) throw new NotFoundError('Delivery workspace');

  const mine = await exec.query.allocations.findMany({
    where: and(
      eq(allocations.deliveryWorkspaceId, workspaceId),
      eq(allocations.volunteerUserId, userId),
    ),
    columns: { id: true },
  });

  return {
    workspaceId,
    projectId: ws.projectId,
    charityOrgId: project.charityOrgId,
    corporationOrgId: pledge.corporationOrgId,
    side: charityMembership ? 'charity' : 'corporation',
    isCharityOwner: charityMembership?.role === 'charity_owner',
    isCsrManager: corpMembership?.role === 'csr_manager',
    allocationIds: mine.map((a) => a.id),
  };
}

/** Milestones are the charity's statement of what "delivered" means. */
function assertCharityOwner(p: Participant) {
  if (!p.isCharityOwner)
    throw new ForbiddenError('Only the charity that owns this project can do this.');
}

/** Tasks are coordination, so either side's coordinator may shape the board. */
function assertCoordinator(p: Participant) {
  if (!p.isCharityOwner && !p.isCsrManager)
    throw new ForbiddenError('Only the charity owner or the CSR manager can do this.');
}

// ── US-6.3 milestones (charity only) ───────────────────────────────────────────
export async function createMilestone(
  actingUserId: string,
  workspaceId: string,
  input: MilestoneInput,
  db: Db = defaultDb,
): Promise<{ milestoneId: string }> {
  const v = milestoneSchema.parse(input);
  return db.transaction(async (tx) => {
    const p = await loadParticipant(tx, actingUserId, workspaceId);
    assertCharityOwner(p);
    const [row] = await tx
      .insert(deliveryMilestones)
      .values({
        deliveryWorkspaceId: workspaceId,
        title: v.title,
        dueOn: v.dueOn ?? null,
        createdBy: actingUserId,
      })
      .returning({ id: deliveryMilestones.id });
    return { milestoneId: row!.id };
  });
}

/**
 * The charity confirms a milestone. Status, confirmer and timestamp are written
 * in one update, so an achieved milestone can never lack the person who said so.
 */
export async function achieveMilestone(
  actingUserId: string,
  milestoneId: string,
  db: Db = defaultDb,
): Promise<void> {
  await db.transaction(async (tx) => {
    const m = await tx.query.deliveryMilestones.findFirst({
      where: eq(deliveryMilestones.id, milestoneId),
    });
    if (!m) throw new NotFoundError('Milestone');
    const p = await loadParticipant(tx, actingUserId, m.deliveryWorkspaceId);
    assertCharityOwner(p);
    if (m.status === 'achieved') throw new InvalidStateError('Milestone already achieved.');

    await tx
      .update(deliveryMilestones)
      .set({ status: 'achieved', achievedAt: new Date(), achievedBy: actingUserId })
      .where(eq(deliveryMilestones.id, milestoneId));
    await tx.insert(outbox).values({
      eventType: 'DeliveryMilestoneAchieved',
      payload: {
        milestoneId,
        title: m.title,
        workspaceId: m.deliveryWorkspaceId,
        projectId: p.projectId,
        corporationOrgId: p.corporationOrgId,
      },
    });
  });
}

// ── US-6.3 tasks ───────────────────────────────────────────────────────────────

/** A milestone and an allocation must belong to the workspace the task is on. */
async function assertBelongsToWorkspace(
  exec: Executor,
  workspaceId: string,
  milestoneId: string | undefined,
  allocationId: string | null | undefined,
) {
  if (milestoneId) {
    const m = await exec.query.deliveryMilestones.findFirst({
      where: eq(deliveryMilestones.id, milestoneId),
      columns: { deliveryWorkspaceId: true },
    });
    if (!m || m.deliveryWorkspaceId !== workspaceId)
      throw new InvalidStateError('That milestone is not on this workspace.');
  }
  if (allocationId) {
    const a = await exec.query.allocations.findFirst({
      where: eq(allocations.id, allocationId),
      columns: { deliveryWorkspaceId: true },
    });
    // US-6.3: assignment is only ever to a volunteer allocated to THIS workspace.
    if (!a || a.deliveryWorkspaceId !== workspaceId)
      throw new InvalidStateError('That volunteer is not allocated to this workspace.');
  }
}

export async function createTask(
  actingUserId: string,
  workspaceId: string,
  input: TaskInput,
  db: Db = defaultDb,
): Promise<{ taskId: string }> {
  const v = taskSchema.parse(input);
  return db.transaction(async (tx) => {
    const p = await loadParticipant(tx, actingUserId, workspaceId);
    assertCoordinator(p);
    await assertBelongsToWorkspace(tx, workspaceId, v.milestoneId, v.assignedAllocationId);

    const [row] = await tx
      .insert(deliveryTasks)
      .values({
        deliveryWorkspaceId: workspaceId,
        milestoneId: v.milestoneId ?? null,
        title: v.title,
        detail: v.detail ?? null,
        assignedAllocationId: v.assignedAllocationId ?? null,
        createdBy: actingUserId,
      })
      .returning({ id: deliveryTasks.id });
    if (v.assignedAllocationId)
      await emitTaskAssigned(tx, p, row!.id, v.title, v.assignedAllocationId);
    return { taskId: row!.id };
  });
}

async function emitTaskAssigned(
  exec: Executor,
  p: Participant,
  taskId: string,
  title: string,
  allocationId: string,
) {
  const alloc = await exec.query.allocations.findFirst({
    where: eq(allocations.id, allocationId),
    columns: { volunteerUserId: true },
  });
  if (!alloc) return;
  await exec.insert(outbox).values({
    eventType: 'DeliveryTaskAssigned',
    payload: {
      taskId,
      title,
      workspaceId: p.workspaceId,
      projectId: p.projectId,
      volunteerUserId: alloc.volunteerUserId,
    },
  });
}

/**
 * Move or reassign a task. A volunteer may move their **own** task and nothing
 * else; reassignment is a coordinator's decision, never the assignee's, or a
 * volunteer could hand their work to a colleague unilaterally.
 */
export async function updateTask(
  actingUserId: string,
  taskId: string,
  input: UpdateTaskInput,
  db: Db = defaultDb,
): Promise<void> {
  const v = updateTaskSchema.parse(input);
  await db.transaction(async (tx) => {
    const task = await tx.query.deliveryTasks.findFirst({ where: eq(deliveryTasks.id, taskId) });
    if (!task) throw new NotFoundError('Task');
    const p = await loadParticipant(tx, actingUserId, task.deliveryWorkspaceId);
    const isCoordinator = p.isCharityOwner || p.isCsrManager;
    const isAssignee =
      !!task.assignedAllocationId && p.allocationIds.includes(task.assignedAllocationId);

    if (v.assignedAllocationId !== undefined) {
      assertCoordinator(p);
      await assertBelongsToWorkspace(
        tx,
        task.deliveryWorkspaceId,
        undefined,
        v.assignedAllocationId,
      );
    }
    if (v.status !== undefined && !isCoordinator && !isAssignee)
      throw new ForbiddenError('You can only move a task assigned to you.');

    const changes: Partial<typeof deliveryTasks.$inferInsert> = { updatedAt: new Date() };
    if (v.status !== undefined) {
      changes.status = v.status;
      // completedAt tracks the status rather than accumulating: moving a task
      // back out of `done` must not leave a completion date behind it.
      changes.completedAt = v.status === 'done' ? (task.completedAt ?? new Date()) : null;
    }
    if (v.assignedAllocationId !== undefined) changes.assignedAllocationId = v.assignedAllocationId;

    await tx.update(deliveryTasks).set(changes).where(eq(deliveryTasks.id, taskId));

    const reassigned =
      !!v.assignedAllocationId && v.assignedAllocationId !== task.assignedAllocationId;
    if (reassigned) await emitTaskAssigned(tx, p, taskId, task.title, v.assignedAllocationId!);
  });
}

// ── US-6.3 / US-6.4 reads ──────────────────────────────────────────────────────

interface MilestoneView {
  id: string;
  title: string;
  dueOn: string | null;
  status: 'open' | 'achieved';
  achievedAt: Date | null;
  taskCounts: { todo: number; inProgress: number; done: number };
  /** Every task is done but the charity has not confirmed it (US-6.3). */
  readyToConfirm: boolean;
  overdue: boolean;
}

const today = () => new Date().toISOString().slice(0, 10);

function buildMilestoneViews(
  milestones: (typeof deliveryMilestones.$inferSelect)[],
  tasks: (typeof deliveryTasks.$inferSelect)[],
): MilestoneView[] {
  const day = today();
  return milestones.map((m) => {
    const mine = tasks.filter((t) => t.milestoneId === m.id);
    const counts = {
      todo: mine.filter((t) => t.status === 'todo').length,
      inProgress: mine.filter((t) => t.status === 'in_progress').length,
      done: mine.filter((t) => t.status === 'done').length,
    };
    return {
      id: m.id,
      title: m.title,
      dueOn: m.dueOn,
      status: m.status,
      achievedAt: m.achievedAt,
      taskCounts: counts,
      readyToConfirm: m.status === 'open' && mine.length > 0 && counts.done === mine.length,
      overdue: m.status === 'open' && !!m.dueOn && m.dueOn < day,
    };
  });
}

/**
 * Effort on a workspace, as three figures that are never one figure: the weekly
 * capacity the corporation allocated, the hours actually approved, and the hours
 * still awaiting approval (US-6.2a). Summing them would claim delivered value
 * that nobody has verified.
 */
async function effortFor(exec: Executor, workspaceIds: string[]) {
  const empty = { allocatedHoursPerWeek: 0, approvedHours: 0, pendingHours: 0, volunteerCount: 0 };
  if (workspaceIds.length === 0) return empty;
  const allocs = await exec.query.allocations.findMany({
    where: inArray(allocations.deliveryWorkspaceId, workspaceIds),
  });
  if (allocs.length === 0) return empty;
  const logs = await exec.query.hourLogs.findMany({
    where: inArray(
      hourLogs.allocationId,
      allocs.map((a) => a.id),
    ),
    columns: { hours: true, status: true },
  });
  const sum = (status: string) =>
    logs.filter((l) => l.status === status).reduce((total, l) => total + l.hours, 0);
  return {
    allocatedHoursPerWeek: allocs.reduce((total, a) => total + a.hoursPerWeek, 0),
    approvedHours: sum('approved'),
    pendingHours: sum('pending'),
    volunteerCount: new Set(allocs.map((a) => a.volunteerUserId)).size,
  };
}

/**
 * Name the allocated volunteers for the board.
 *
 * A user has no name field yet — only an email (named volunteer profiles are
 * US-1.5) — and a corporation's employee roster is not the charity's data. So
 * the corporation, whose own members these are, sees the email it already
 * holds (via Identity's own authorised read); the charity sees a stable
 * neutral label. The CSR manager needs to know who they are assigning to; the
 * charity only needs to see that the work is spread across people.
 */
async function labelAllocations(
  exec: Executor,
  p: Participant,
  actingUserId: string,
  allocs: (typeof allocations.$inferSelect)[],
) {
  const emails = new Map<string, string | null>();
  if (p.side === 'corporation') {
    const members = await listMembers(actingUserId, p.corporationOrgId, exec as Db);
    // US-1.5 — the display name where there is one. The charity branch below
    // is untouched: they still see `Volunteer N`.
    for (const m of members) emails.set(m.userId, m.label);
  }
  return allocs.map((a, i) => ({
    id: a.id,
    volunteerUserId: a.volunteerUserId,
    hoursPerWeek: a.hoursPerWeek,
    label: emails.get(a.volunteerUserId) ?? `Volunteer ${i + 1}`,
    isYou: a.volunteerUserId === actingUserId,
  }));
}

/** US-6.3 — the shared board, the same board for both organisations. */
export async function getWorkspaceBoard(
  actingUserId: string,
  workspaceId: string,
  db: Db = defaultDb,
) {
  const p = await loadParticipant(db, actingUserId, workspaceId);
  const project = await getProjectRef(p.projectId, db);
  const [milestones, tasks, allocs] = await Promise.all([
    db.query.deliveryMilestones.findMany({
      where: eq(deliveryMilestones.deliveryWorkspaceId, workspaceId),
      orderBy: [asc(deliveryMilestones.createdAt)],
    }),
    db.query.deliveryTasks.findMany({
      where: eq(deliveryTasks.deliveryWorkspaceId, workspaceId),
      orderBy: [asc(deliveryTasks.createdAt)],
    }),
    db.query.allocations.findMany({
      where: eq(allocations.deliveryWorkspaceId, workspaceId),
    }),
  ]);

  return {
    workspaceId,
    project: { id: p.projectId, title: project?.title ?? '', goal: project?.goal ?? null },
    // US-8.3 — already on the internal participant; surfaced so the board can
    // link to the one conversation for this project and this corporation.
    corporationOrgId: p.corporationOrgId,
    // What the reader may do, so the UI never offers an action the domain refuses.
    viewer: {
      side: p.side,
      canManageMilestones: p.isCharityOwner,
      canManageTasks: p.isCharityOwner || p.isCsrManager,
      allocationIds: p.allocationIds,
    },
    milestones: buildMilestoneViews(milestones, tasks),
    tasks: tasks.map((t) => ({
      id: t.id,
      milestoneId: t.milestoneId,
      title: t.title,
      detail: t.detail,
      status: t.status,
      assignedAllocationId: t.assignedAllocationId,
    })),
    allocations: await labelAllocations(db, p, actingUserId, allocs),
    effort: await effortFor(db, [workspaceId]),
  };
}

/**
 * The delivery workspace on this project that the caller may open, or null.
 *
 * Exists so a page can offer the workspace link to whichever side is looking
 * without either of them having to know the workspace id, and without a
 * caller-side authorisation check: participation is decided the same way the
 * board decides it. A project has at most one live workspace in practice, so
 * the loop is over one or two rows.
 */
export async function findWorkspaceForParticipant(
  actingUserId: string,
  projectId: string,
  db: Db = defaultDb,
): Promise<{ workspaceId: string } | null> {
  const workspaces = await db.query.deliveryWorkspaces.findMany({
    where: eq(deliveryWorkspaces.projectId, projectId),
    columns: { id: true },
  });
  for (const w of workspaces) {
    try {
      await loadParticipant(db, actingUserId, w.id);
      return { workspaceId: w.id };
    } catch (e) {
      // "Not yours" is the expected answer and means keep looking. Anything
      // else is a real failure and must not be swallowed into "no workspace".
      if (!(e instanceof NotFoundError)) throw e;
    }
  }
  return null;
}

/**
 * US-6.4 — the charity owner's progress read for a whole project, across every
 * delivery workspace on it (a project can be reopened and re-pledged).
 *
 * When nothing is in delivery this returns `inDelivery: false` rather than an
 * empty board: an empty board reads as "0% done", which is a different and
 * misleading claim about work nobody has started.
 */
export async function getDeliveryProgress(
  actingUserId: string,
  projectId: string,
  db: Db = defaultDb,
) {
  const project = await getProjectRef(projectId, db);
  if (!project) throw new NotFoundError('Project');
  const membership = await findMembership(actingUserId, project.charityOrgId, db);
  if (!membership) throw new NotFoundError('Project'); // no existence leak across tenants
  if (membership.role !== 'charity_owner') throw new ForbiddenError();

  const workspaces = await db.query.deliveryWorkspaces.findMany({
    where: eq(deliveryWorkspaces.projectId, projectId),
    columns: { id: true },
  });
  const base = {
    projectId,
    title: project.title,
    goal: project.goal ?? null,
    status: project.status,
  };
  if (workspaces.length === 0) return { ...base, inDelivery: false as const };

  const ids = workspaces.map((w) => w.id);
  const [milestones, tasks] = await Promise.all([
    db.query.deliveryMilestones.findMany({
      where: inArray(deliveryMilestones.deliveryWorkspaceId, ids),
      orderBy: [asc(deliveryMilestones.createdAt)],
    }),
    db.query.deliveryTasks.findMany({ where: inArray(deliveryTasks.deliveryWorkspaceId, ids) }),
  ]);
  const views = buildMilestoneViews(milestones, tasks);
  const looseTasks = tasks.filter((t) => t.milestoneId === null);

  return {
    ...base,
    inDelivery: true as const,
    workspaceIds: ids,
    milestones: views,
    milestoneSummary: {
      total: views.length,
      achieved: views.filter((m) => m.status === 'achieved').length,
      awaitingConfirmation: views.filter((m) => m.readyToConfirm).length,
      overdue: views.filter((m) => m.overdue).length,
    },
    // Tasks nobody has filed under a milestone yet — shown, not hidden, so the
    // milestone counts are never mistaken for the whole of the work.
    unscheduledTasks: {
      todo: looseTasks.filter((t) => t.status === 'todo').length,
      inProgress: looseTasks.filter((t) => t.status === 'in_progress').length,
      done: looseTasks.filter((t) => t.status === 'done').length,
    },
    effort: await effortFor(db, ids),
  };
}
