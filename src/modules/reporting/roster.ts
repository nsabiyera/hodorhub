import { db as defaultDb } from '@/db';
import { listMembershipProfiles } from '@/modules/identity';
import { getVolunteerLoad } from '@/modules/delivery';

type Db = typeof defaultDb;

/**
 * US-1.5 — the CSR manager's roster: who is on the team, what they can do, how
 * much they offered, and how much they are already carrying.
 *
 * Reporting composes it because it spans two contexts (Identity's profiles,
 * Delivery's load) and owns neither. It adds **no authorisation of its own** —
 * both underlying reads authorise independently, which is what stops a composer
 * from becoming a bypass — and it owns no tables, so `boundary.test.ts` applies.
 *
 * Deliberately NOT entitlement-gated: knowing your own team is not a paid
 * feature (MONETISATION_MODEL Principle 3).
 */

export interface RosterEntry {
  userId: string;
  role: string;
  /** displayName ?? email, or 'Former member'. Identity's one definition. */
  label: string;
  /** The admin keeps this — it is the key they invited by (US-1.5). */
  email: string | null;
  displayName: string | null;
  /** null = nobody said. NEVER coalesced to 0, which means "offered none". */
  weeklyHours: number | null;
  seniority: { code: string; label: string } | null;
  skills: { code: string; label: string }[];
  note: string | null;
  hasProfile: boolean;
  /** Delivery's sum over THIS organisation's live workspaces. */
  allocatedHoursPerWeek: number;
  /** null when weeklyHours is null — unknown is never "over". */
  overAllocated: boolean | null;
  overBy: number | null;
}

export async function getVolunteerRoster(
  actingUserId: string,
  organisationId: string,
  db: Db = defaultDb,
): Promise<{ organisationId: string; entries: RosterEntry[] }> {
  // Identity authorises first and throws 404/403 for anyone who may not read a
  // roster, so the Delivery read below is never reached by an outsider.
  const members = await listMembershipProfiles(actingUserId, organisationId, db);
  if (members.length === 0) return { organisationId, entries: [] };

  const load = await getVolunteerLoad(
    actingUserId,
    organisationId,
    members.map((m) => m.userId),
    db,
  );
  const loadByUser = new Map(load.map((l) => [l.volunteerUserId, l]));

  return {
    organisationId,
    entries: members.map((m) => {
      const l = loadByUser.get(m.userId);
      return {
        userId: m.userId,
        role: m.role,
        label: m.label,
        email: m.email,
        displayName: m.displayName,
        weeklyHours: m.weeklyHours,
        seniority: m.seniority,
        skills: m.skills,
        note: m.note,
        hasProfile: m.hasProfile,
        allocatedHoursPerWeek: l?.allocatedHoursPerWeek ?? 0,
        overAllocated: l?.overAllocated ?? null,
        overBy: l?.overBy ?? null,
      };
    }),
  };
}
