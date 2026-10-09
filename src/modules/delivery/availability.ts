import { inArray } from 'drizzle-orm';
import { db as defaultDb } from '@/db';
import { allocations, deliveryWorkspaces } from '@/db/schema';
import {
  findMembership,
  getMembershipAvailability,
  ForbiddenError,
  NotFoundError,
} from '@/modules/identity';
import { getProjectSummaries } from '@/modules/projects';
import { getPledgeRefs } from '@/modules/commitments';

/**
 * US-1.5 — how loaded a volunteer is against the hours they offered.
 *
 * **Delivery computes this, not Identity.** Availability is Identity's data and
 * allocations are Delivery's, so somebody has to cross the line. Delivery
 * already imports Identity (`findMembership`, `listMembers`); Identity
 * importing Delivery would be a cycle. Reporting cannot own it either, because
 * the figure is needed on a *write* path — `allocateVolunteer` must flag and
 * notify — and Reporting is read-only.
 *
 * The figure is DERIVED at read time, never stored, and never shown to the
 * charity (US-6.3's roster-withholding is unchanged).
 */

type Db = typeof defaultDb;
type Tx = Parameters<Parameters<Db['transaction']>[0]>[0];
type Executor = Db | Tx;

/** A project in one of these statuses no longer consumes anybody's week. */
const FINISHED_STATUSES = new Set(['completed', 'archived']);

export interface VolunteerLoad {
  volunteerUserId: string;
  /** Committed hours/week across THIS organisation's live workspaces. */
  allocatedHoursPerWeek: number;
  /** The membership profile's figure. null = NO STATED AVAILABILITY, never 0. */
  statedWeeklyHours: number | null;
  /** null when nothing was stated — unknown is never "over". */
  overAllocated: boolean | null;
  /** allocatedHoursPerWeek - statedWeeklyHours when over; otherwise null. */
  overBy: number | null;
  /** Where the load is, so a manager can act on it. Live workspaces only. */
  liveWorkspaceIds: string[];
}

/**
 * The sum, with no authorisation of its own — callers have already established
 * standing. Scoped to ONE organisation's workspaces on purpose: a global sum
 * would compare this employer's stated hours against a total inflated by
 * another employer's allocations, warning about a constraint they cannot see,
 * and would leak the existence of a second membership through the arithmetic.
 */
async function loadFor(
  exec: Executor,
  organisationId: string,
  volunteerUserIds: string[],
): Promise<VolunteerLoad[]> {
  const ids = [...new Set(volunteerUserIds)];
  if (ids.length === 0) return [];

  const allocRows = await exec.query.allocations.findMany({
    where: inArray(allocations.volunteerUserId, ids),
  });

  // Narrow to this organisation's live workspaces: workspace -> pledge (whose
  // corporation it is) and workspace -> project (whether it is still running).
  const workspaceIds = [...new Set(allocRows.map((a) => a.deliveryWorkspaceId))];
  const workspaces = workspaceIds.length
    ? await exec.query.deliveryWorkspaces.findMany({
        where: inArray(deliveryWorkspaces.id, workspaceIds),
      })
    : [];
  const [pledgeRefs, projectRefs] = await Promise.all([
    getPledgeRefs(
      workspaces.map((w) => w.pledgeId),
      exec,
    ),
    getProjectSummaries(
      workspaces.map((w) => w.projectId),
      exec,
    ),
  ]);
  const pledgeById = new Map(pledgeRefs.map((p) => [p.id, p]));
  const statusByProject = new Map(projectRefs.map((p) => [p.id, p.status]));

  const liveWorkspaces = new Set(
    workspaces
      .filter((w) => {
        const pledge = pledgeById.get(w.pledgeId);
        if (!pledge || pledge.corporationOrgId !== organisationId) return false;
        const status = statusByProject.get(w.projectId);
        return status !== undefined && !FINISHED_STATUSES.has(status);
      })
      .map((w) => w.id),
  );

  const stated = new Map(
    (await getMembershipAvailability(organisationId, ids, exec)).map((a) => [
      a.userId,
      a.weeklyHours,
    ]),
  );

  return ids.map((volunteerUserId) => {
    const mine = allocRows.filter(
      (a) => a.volunteerUserId === volunteerUserId && liveWorkspaces.has(a.deliveryWorkspaceId),
    );
    // A plain SUM, matching `effortFor` exactly — deliberately NOT defensively
    // de-duplicated. The unique constraint makes double-counting impossible; if
    // it were ever dropped, over-counting surfaces the corruption, where a
    // silent MAX() would hide it.
    const allocatedHoursPerWeek = mine.reduce((n, a) => n + a.hoursPerWeek, 0);
    const statedWeeklyHours = stated.get(volunteerUserId) ?? null;
    const over = statedWeeklyHours !== null && allocatedHoursPerWeek > statedWeeklyHours;
    return {
      volunteerUserId,
      allocatedHoursPerWeek,
      statedWeeklyHours,
      overAllocated: statedWeeklyHours === null ? null : over,
      overBy: over ? allocatedHoursPerWeek - statedWeeklyHours! : null,
      liveWorkspaceIds: mine.map((a) => a.deliveryWorkspaceId),
    };
  });
}

/** Internal, for callers that have already authorised (the allocation path). */
export const volunteerLoadFor = loadFor;

/**
 * US-1.5 — the authorised read. 404 for a non-member (whether an organisation
 * has a roster is not a non-member's to learn), 403 for the wrong role.
 */
export async function getVolunteerLoad(
  actingUserId: string,
  organisationId: string,
  volunteerUserIds: string[],
  db: Db = defaultDb,
): Promise<VolunteerLoad[]> {
  const actor = await findMembership(actingUserId, organisationId, db);
  if (!actor) throw new NotFoundError('Organisation');
  if (actor.role !== 'csr_manager' && actor.role !== 'charity_owner') {
    throw new ForbiddenError('Only an administrator can see volunteer availability.');
  }
  return loadFor(db, organisationId, volunteerUserIds);
}
