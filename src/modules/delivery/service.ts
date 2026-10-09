import { eq, inArray } from 'drizzle-orm';
import { z } from 'zod';
import { db as defaultDb } from '@/db';
import { allocations, hourLogs, deliveryWorkspaces, outbox } from '@/db/schema';
import {
  findMembership,
  NotFoundError,
  ForbiddenError,
  InvalidStateError,
} from '@/modules/identity';
import { getPledgeRef } from '@/modules/commitments';
import { getProjectRef } from '@/modules/projects';
import { volunteerLoadFor, type VolunteerLoad } from './availability';

/**
 * Delivery service — US-6.1 (allocate volunteers), US-6.2 (log hours),
 * US-6.2a (employer approval). The locked invariant: hours count toward reported
 * totals ONLY once a CSR manager approves them; pending vs approved stay distinct.
 * Owns `allocations` and `hour_logs`; resolves the owning corp via Commitments.
 */
type Db = typeof defaultDb;
type Tx = Parameters<Parameters<Db['transaction']>[0]>[0];
type Executor = Db | Tx;

export const logHoursSchema = z.object({
  hours: z.number().int().min(1).max(168),
  note: z.string().trim().max(1000).optional(),
});

// Resolve the corporation that owns a delivery workspace (via its pledge).
async function corpForWorkspace(exec: Executor, workspaceId: string): Promise<string> {
  const ws = await exec.query.deliveryWorkspaces.findFirst({
    where: eq(deliveryWorkspaces.id, workspaceId),
  });
  if (!ws) throw new NotFoundError('Delivery workspace');
  const pledge = await getPledgeRef(ws.pledgeId, exec);
  if (!pledge) throw new NotFoundError('Delivery workspace');
  return pledge.corporationOrgId;
}

async function assertCsrManager(exec: Executor, userId: string, corporationOrgId: string) {
  const m = await findMembership(userId, corporationOrgId, exec);
  if (!m) throw new NotFoundError('Delivery workspace'); // not their corp → no leak
  if (m.role !== 'csr_manager') throw new ForbiddenError('Only a CSR manager can do this.');
}

// ── US-6.1 allocate a volunteer ────────────────────────────────────────────────
export async function allocateVolunteer(
  actingUserId: string,
  workspaceId: string,
  volunteerUserId: string,
  hoursPerWeek: number,
  db: Db = defaultDb,
): Promise<{ allocationId: string; load: VolunteerLoad }> {
  z.number().int().min(1).max(40).parse(hoursPerWeek);
  return db.transaction(async (tx) => {
    const corp = await corpForWorkspace(tx, workspaceId);
    await assertCsrManager(tx, actingUserId, corp);
    // The volunteer must belong to the same corporation.
    const vm = await findMembership(volunteerUserId, corp, tx);
    if (!vm) throw new InvalidStateError('The volunteer must belong to your organisation.');

    // US-1.5 — the load BEFORE this allocation, so the notification fires only
    // on a transition into (or a worsening of) over-allocation rather than on
    // every subsequent edit.
    const [before] = await volunteerLoadFor(tx, corp, [volunteerUserId]);

    // Upsert: one person, one workspace, one weekly commitment. A second row is
    // not a second commitment, it is a re-allocation — so moving someone from 4
    // to 6 hours means 6, not 10, which is the only reading a manager expects,
    // and a double-clicked button becomes idempotent. `onConflictDoUpdate`
    // never `DoNothing`: DO NOTHING returns zero rows on conflict.
    const [row] = await tx
      .insert(allocations)
      .values({ deliveryWorkspaceId: workspaceId, volunteerUserId, hoursPerWeek })
      .onConflictDoUpdate({
        target: [allocations.deliveryWorkspaceId, allocations.volunteerUserId],
        set: { hoursPerWeek },
      })
      .returning({ id: allocations.id });
    await tx.insert(outbox).values({
      eventType: 'VolunteerAllocated',
      payload: { workspaceId, volunteerUserId, allocationId: row!.id },
    });

    const [load] = await volunteerLoadFor(tx, corp, [volunteerUserId]);
    // Over-allocation WARNS, it never refuses: the employer authorises the
    // donation (the same authority direction as US-6.2a), and a hard cap would
    // bind only the people honest enough to state their hours.
    const worsened = load?.overAllocated === true && (load.overBy ?? 0) > (before?.overBy ?? 0);
    if (worsened) {
      await tx.insert(outbox).values({
        eventType: 'VolunteerOverAllocated',
        payload: {
          workspaceId,
          volunteerUserId,
          corporationOrgId: corp,
          allocatedHoursPerWeek: load.allocatedHoursPerWeek,
          statedWeeklyHours: load.statedWeeklyHours,
          overBy: load.overBy,
        },
      });
    }
    // `volunteerLoadFor` with one id always yields one row, so this is total.
    return { allocationId: row!.id, load: load! };
  });
}

// ── US-6.2 log donated hours (enters PENDING) ──────────────────────────────────
export async function logHours(
  actingUserId: string,
  allocationId: string,
  input: z.infer<typeof logHoursSchema>,
  db: Db = defaultDb,
): Promise<{ hourLogId: string }> {
  const v = logHoursSchema.parse(input);
  return db.transaction(async (tx) => {
    const alloc = await tx.query.allocations.findFirst({ where: eq(allocations.id, allocationId) });
    if (!alloc) throw new NotFoundError('Allocation');
    // Only the allocated volunteer may log their own hours.
    if (alloc.volunteerUserId !== actingUserId) throw new ForbiddenError();

    const [row] = await tx
      .insert(hourLogs)
      .values({
        allocationId,
        volunteerUserId: actingUserId,
        hours: v.hours,
        note: v.note ?? null,
        status: 'pending', // US-6.2a: does NOT count until approved
      })
      .returning({ id: hourLogs.id });
    await tx.insert(outbox).values({
      eventType: 'HoursLogged',
      payload: { allocationId, hourLogId: row!.id, hours: v.hours },
    });
    return { hourLogId: row!.id };
  });
}

// ── US-6.2a employer approval ──────────────────────────────────────────────────
export function approveHours(actingUserId: string, hourLogId: string, db: Db = defaultDb) {
  return decideHours(db, actingUserId, hourLogId, 'approved', null);
}
export async function rejectHours(
  actingUserId: string,
  hourLogId: string,
  reason: string,
  db: Db = defaultDb,
) {
  if (!reason?.trim()) throw new InvalidStateError('A rejection reason is required.');
  return decideHours(db, actingUserId, hourLogId, 'rejected', reason.trim());
}

async function decideHours(
  db: Db,
  actingUserId: string,
  hourLogId: string,
  outcome: 'approved' | 'rejected',
  reason: string | null,
): Promise<void> {
  await db.transaction(async (tx) => {
    const log = await tx.query.hourLogs.findFirst({ where: eq(hourLogs.id, hourLogId) });
    if (!log) throw new NotFoundError('Hour log');
    const alloc = await tx.query.allocations.findFirst({
      where: eq(allocations.id, log.allocationId),
    });
    if (!alloc) throw new NotFoundError('Hour log');
    const corp = await corpForWorkspace(tx, alloc.deliveryWorkspaceId);
    await assertCsrManager(tx, actingUserId, corp);
    if (log.status !== 'pending') throw new InvalidStateError(`Hours already ${log.status}.`);

    await tx
      .update(hourLogs)
      .set({ status: outcome, approvedBy: actingUserId, decidedReason: reason })
      .where(eq(hourLogs.id, hourLogId));
    await tx.insert(outbox).values({
      eventType: outcome === 'approved' ? 'HoursApproved' : 'HoursRejected',
      payload: { hourLogId, volunteerUserId: log.volunteerUserId, reason },
    });
  });
}

// ── Reporting — approved vs pending kept distinct (US-6.2a) ─────────────────────
export async function getWorkspaceHours(
  actingUserId: string,
  workspaceId: string,
  db: Db = defaultDb,
) {
  const corp = await corpForWorkspace(db, workspaceId);
  await assertCsrManager(db, actingUserId, corp);
  const allocs = await db.query.allocations.findMany({
    where: eq(allocations.deliveryWorkspaceId, workspaceId),
  });
  const ids = allocs.map((a) => a.id);
  const logs = ids.length
    ? await db.query.hourLogs.findMany({ where: inArray(hourLogs.allocationId, ids) })
    : [];
  const sum = (s: string) => logs.filter((l) => l.status === s).reduce((t, l) => t + l.hours, 0);
  return {
    approvedHours: sum('approved'),
    pendingHours: sum('pending'),
    rejectedHours: sum('rejected'),
    logs,
  };
}

/**
 * US-7.2 — donated hours on a project, for the owning charity's impact summary.
 * Sums across every delivery workspace on the project (a project can be
 * reopened and re-pledged, so more than one is possible).
 *
 * The approved/pending split is the point, not a detail: only approved hours
 * are delivered value (US-6.2a), so they are returned as separate totals that a
 * caller cannot accidentally add together into a single misleading figure.
 */
export async function getProjectHoursForCharity(
  actingUserId: string,
  projectId: string,
  db: Db = defaultDb,
): Promise<{ approvedHours: number; pendingHours: number; volunteerCount: number }> {
  const ref = await getProjectRef(projectId, db);
  if (!ref) throw new NotFoundError('Project');
  const membership = await findMembership(actingUserId, ref.charityOrgId, db);
  if (!membership) throw new NotFoundError('Project'); // no existence leak to another tenant
  if (membership.role !== 'charity_owner') throw new ForbiddenError();

  const workspaces = await db.query.deliveryWorkspaces.findMany({
    where: eq(deliveryWorkspaces.projectId, projectId),
    columns: { id: true },
  });
  if (workspaces.length === 0) return { approvedHours: 0, pendingHours: 0, volunteerCount: 0 };

  const allocs = await db.query.allocations.findMany({
    where: inArray(
      allocations.deliveryWorkspaceId,
      workspaces.map((w) => w.id),
    ),
  });
  if (allocs.length === 0) return { approvedHours: 0, pendingHours: 0, volunteerCount: 0 };

  const logs = await db.query.hourLogs.findMany({
    where: inArray(
      hourLogs.allocationId,
      allocs.map((a) => a.id),
    ),
  });
  const sum = (status: string) =>
    logs.filter((l) => l.status === status).reduce((total, l) => total + l.hours, 0);
  return {
    approvedHours: sum('approved'),
    pendingHours: sum('pending'),
    volunteerCount: new Set(allocs.map((a) => a.volunteerUserId)).size,
  };
}

/**
 * US-7.1 — donated hours across every project this corporation has delivered
 * on, for its CSR dashboard. Resolves workspaces via the corporation's own
 * pledges, so another corporation's hours can never enter the total.
 *
 * As with the per-project read, approved and pending come back as separate
 * figures: the dashboard headline is approved hours only (US-6.2a).
 */
export async function getCorporateHours(
  actingUserId: string,
  corporationOrgId: string,
  pledgeIds: string[],
  db: Db = defaultDb,
): Promise<{ approvedHours: number; pendingHours: number; volunteerCount: number }> {
  const membership = await findMembership(actingUserId, corporationOrgId, db);
  if (!membership) throw new NotFoundError('Organisation');
  if (membership.role !== 'csr_manager')
    throw new ForbiddenError('Only a CSR manager can do this.');
  const empty = { approvedHours: 0, pendingHours: 0, volunteerCount: 0 };
  if (pledgeIds.length === 0) return empty;

  const workspaces = await db.query.deliveryWorkspaces.findMany({
    where: inArray(deliveryWorkspaces.pledgeId, pledgeIds),
    columns: { id: true },
  });
  if (workspaces.length === 0) return empty;

  const allocs = await db.query.allocations.findMany({
    where: inArray(
      allocations.deliveryWorkspaceId,
      workspaces.map((w) => w.id),
    ),
  });
  if (allocs.length === 0) return empty;

  const logs = await db.query.hourLogs.findMany({
    where: inArray(
      hourLogs.allocationId,
      allocs.map((a) => a.id),
    ),
  });
  const sum = (status: string) =>
    logs.filter((l) => l.status === status).reduce((total, l) => total + l.hours, 0);
  return {
    approvedHours: sum('approved'),
    pendingHours: sum('pending'),
    volunteerCount: new Set(allocs.map((a) => a.volunteerUserId)).size,
  };
}
