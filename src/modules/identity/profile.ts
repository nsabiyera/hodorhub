import { and, asc, eq, inArray } from 'drizzle-orm';
import { z } from 'zod';
import { db as defaultDb } from '@/db';
import {
  users,
  memberships,
  organisations,
  membershipProfiles,
  membershipProfileSkills,
} from '@/db/schema';
import { ForbiddenError, NotFoundError } from './errors';
import {
  VOLUNTEER_SKILL_CODES,
  SENIORITY_CODES,
  getSkill,
  getSeniority,
  type SkillCategory,
} from './skills';

/**
 * US-1.5 — volunteer profiles.
 *
 * The profile belongs to the **membership**, not the person: donated hours are
 * one employer's hours to donate, so "4 hours a week" is only ever a statement
 * about one employer's week, and nothing is copied between organisations. The
 * **display name** is the exception — one human, one name — and lives on
 * `users`.
 *
 * An ABSENT profile row means *no stated availability*, which is NOT
 * `weeklyHours: 0` ("I offered none"). Every read model here keeps the two
 * representable so no caller can quietly turn "nobody said" into a number.
 */

type Db = typeof defaultDb;
type Tx = Parameters<Parameters<Db['transaction']>[0]>[0];
type Executor = Db | Tx;

/** Rejects control characters — a display name is shown to other organisations. */
const noControlChars = (s: string) => !/[\p{Cc}\p{Cf}]/u.test(s);

export const displayNameSchema = z
  .string()
  .trim()
  .min(1)
  .max(80)
  .refine(noControlChars, 'That name contains characters that are not allowed.');

export const profileSchema = z.object({
  /** `null` clears the name; `undefined` leaves it alone. */
  displayName: displayNameSchema.nullable().optional(),
  weeklyHours: z.number().int().min(0).max(168),
  // At least one skill: a profile asserting "I have no skills" is not a thing
  // worth storing. The route to having none is deleting the profile.
  //
  // Uniqueness is enforced HERE, not left to the primary key: the rows are
  // inserted verbatim, so a body repeating a code would hit a raw 23505 and
  // surface as a 500 on a public route. A repeated checkbox is a bad request,
  // and it should read like one.
  skills: z
    .array(z.enum(VOLUNTEER_SKILL_CODES))
    .min(1)
    .max(12)
    .refine((list) => new Set(list).size === list.length, 'Each skill can only be chosen once.'),
  seniority: z.enum(SENIORITY_CODES).nullable().optional(),
  note: z.string().trim().max(500).nullable().optional(),
});
export type ProfileInput = z.infer<typeof profileSchema>;

/**
 * How a person is named to other humans. ONE definition, applied by the reads
 * themselves rather than exported for callers to remember — Messaging and
 * Delivery must not each carry their own copy.
 *
 * The `deletedAt` check is first and is deliberately redundant: `eraseUser`
 * nulls `display_name` in the same statement that anonymises the email, so an
 * erased row could not produce a real name anyway. If that null-ing were ever
 * dropped in a refactor, this still reads *Former member*. Two independent
 * mechanisms, one outcome, a test for each.
 */
export function personLabel(u: {
  email: string;
  displayName: string | null;
  deletedAt: Date | null;
}): string {
  if (u.deletedAt) return 'Former member';
  return u.displayName ?? u.email;
}

export interface MyProfileView {
  userId: string;
  email: string;
  displayName: string | null;
  /** What other people see today — the same string `authorLabel` uses. */
  label: string;
  /** null for someone with no membership at all (a platform admin, a supporter). */
  membership: {
    organisationId: string;
    organisationName: string;
    role: string;
    /** null = NO STATED AVAILABILITY. 0 = offered none. Never conflated. */
    weeklyHours: number | null;
    seniority: { code: string; label: string } | null;
    skills: { code: string; label: string; categories: SkillCategory[] }[];
    note: string | null;
    updatedAt: Date | null;
    /** false until they save once. Drives the prompt — never a gate. */
    hasProfile: boolean;
  } | null;
}

/**
 * Resolve the caller's membership. This is the ONE place the known multi-org
 * limit lives (`getUserOrg` picks the first membership arbitrarily), so an
 * organisation switcher is a single edit rather than a hunt.
 */
async function myMembership(exec: Executor, userId: string) {
  // Same ordering as `getUserOrg`, so the profile page and the roster page
  // resolve the SAME membership. Unordered, Postgres may hand back a different
  // one per call, and someone in two organisations could save availability
  // against a different employer on each save.
  return exec.query.memberships.findFirst({
    where: eq(memberships.userId, userId),
    orderBy: [asc(memberships.id)],
  });
}

async function profileFor(exec: Executor, membershipId: string) {
  const [row, skillRows] = await Promise.all([
    exec.query.membershipProfiles.findFirst({
      where: eq(membershipProfiles.membershipId, membershipId),
    }),
    exec.query.membershipProfileSkills.findMany({
      where: eq(membershipProfileSkills.membershipId, membershipId),
    }),
  ]);
  return { row, skillCodes: skillRows.map((s) => s.skillCode) };
}

/** Registry entries for stored codes. Unknown (retired) codes are dropped. */
function hydrateSkills(codes: string[]) {
  return codes.flatMap((code) => {
    const s = getSkill(code);
    return s ? [{ code: s.code, label: s.label, categories: [...s.categories] }] : [];
  });
}

function hydrateSeniority(code: string | null | undefined) {
  if (!code) return null;
  const s = getSeniority(code);
  return s ? { code: s.code, label: s.label } : null;
}

export async function getMyProfile(userId: string, db: Db = defaultDb): Promise<MyProfileView> {
  const user = await db.query.users.findFirst({ where: eq(users.id, userId) });
  if (!user) throw new NotFoundError('User');

  const base = {
    userId,
    email: user.email,
    displayName: user.displayName,
    label: personLabel(user),
  };

  const m = await myMembership(db, userId);
  if (!m) return { ...base, membership: null };

  const org = await db.query.organisations.findFirst({
    where: eq(organisations.id, m.organisationId),
    columns: { name: true },
  });
  const { row, skillCodes } = await profileFor(db, m.id);

  return {
    ...base,
    membership: {
      organisationId: m.organisationId,
      organisationName: org?.name ?? 'Your organisation',
      role: m.role,
      weeklyHours: row?.weeklyHours ?? null,
      seniority: hydrateSeniority(row?.seniority),
      skills: hydrateSkills(skillCodes),
      note: row?.note ?? null,
      updatedAt: row?.updatedAt ?? null,
      hasProfile: row !== undefined,
    },
  };
}

/**
 * Save the caller's own profile. One transaction: upsert the row, replace the
 * skill set wholesale (at most twelve rows — a diff is code nobody needs), and
 * optionally update the display name.
 */
export async function saveMyProfile(
  userId: string,
  input: ProfileInput,
  db: Db = defaultDb,
): Promise<MyProfileView> {
  const v = profileSchema.parse(input);
  await db.transaction(async (tx) => {
    const m = await myMembership(tx, userId);
    if (!m) throw new ForbiddenError('You need to belong to an organisation to set availability.');

    await tx
      .insert(membershipProfiles)
      .values({
        membershipId: m.id,
        weeklyHours: v.weeklyHours,
        seniority: v.seniority ?? null,
        note: v.note ?? null,
      })
      .onConflictDoUpdate({
        target: membershipProfiles.membershipId,
        set: {
          weeklyHours: v.weeklyHours,
          seniority: v.seniority ?? null,
          note: v.note ?? null,
          updatedAt: new Date(),
        },
      });

    await tx.delete(membershipProfileSkills).where(eq(membershipProfileSkills.membershipId, m.id));
    await tx
      .insert(membershipProfileSkills)
      .values(v.skills.map((skillCode) => ({ membershipId: m.id, skillCode })));

    // `undefined` means "not part of this edit"; `null` means "remove my name".
    if (v.displayName !== undefined) {
      await tx.update(users).set({ displayName: v.displayName }).where(eq(users.id, userId));
    }
  });
  return getMyProfile(userId, db);
}

/**
 * Return to *no stated availability* without leaving the organisation. The
 * volunteer's allocations, logged hours and approved hours are untouched —
 * those are the employer's and the charity's record.
 */
export async function deleteMyProfile(userId: string, db: Db = defaultDb): Promise<void> {
  const m = await myMembership(db, userId);
  if (!m) return;
  // The skill rows go with it via ON DELETE CASCADE.
  await db.delete(membershipProfiles).where(eq(membershipProfiles.membershipId, m.id));
}

/**
 * Set or clear a display name. Separate from the profile because a user with
 * NO membership — a supporter, a platform admin — must still be able to be
 * named to other people.
 */
export async function setDisplayName(
  userId: string,
  displayName: string | null,
  db: Db = defaultDb,
): Promise<{ label: string }> {
  const value = displayName === null ? null : displayNameSchema.parse(displayName);
  const [row] = await db
    .update(users)
    .set({ displayName: value })
    .where(eq(users.id, userId))
    .returning({ email: users.email, displayName: users.displayName, deletedAt: users.deletedAt });
  if (!row) throw new NotFoundError('User');
  return { label: personLabel(row) };
}

export interface MembershipProfileEntry {
  userId: string;
  membershipId: string;
  role: string;
  email: string;
  displayName: string | null;
  label: string;
  weeklyHours: number | null;
  seniority: { code: string; label: string } | null;
  skills: { code: string; label: string }[];
  note: string | null;
  hasProfile: boolean;
}

/**
 * Every member of an organisation with their profile, for whoever can allocate.
 *
 * Returns one entry per **membership**, not per profile: a member who has
 * filled in nothing comes back with `hasProfile: false` and `weeklyHours: null`.
 * That is not a convenience — it is what stops a caller zipping two lists of
 * different lengths and defaulting the gaps to 0.
 */
export async function listMembershipProfiles(
  actingUserId: string,
  organisationId: string,
  db: Db = defaultDb,
): Promise<MembershipProfileEntry[]> {
  const mine = await db.query.memberships.findFirst({
    where: and(
      eq(memberships.userId, actingUserId),
      eq(memberships.organisationId, organisationId),
    ),
  });
  // 404 rather than 403 for an outsider: whether an organisation has a roster
  // is not something a non-member gets to learn.
  if (!mine) throw new NotFoundError('Organisation');
  if (mine.role !== 'csr_manager' && mine.role !== 'charity_owner') {
    throw new ForbiddenError('Only an administrator can see the team roster.');
  }

  const rows = await db.query.memberships.findMany({
    where: eq(memberships.organisationId, organisationId),
  });
  if (rows.length === 0) return [];

  const [userRows, profileRows, skillRows] = await Promise.all([
    db.query.users.findMany({
      where: inArray(
        users.id,
        rows.map((r) => r.userId),
      ),
    }),
    db.query.membershipProfiles.findMany({
      where: inArray(
        membershipProfiles.membershipId,
        rows.map((r) => r.id),
      ),
    }),
    db.query.membershipProfileSkills.findMany({
      where: inArray(
        membershipProfileSkills.membershipId,
        rows.map((r) => r.id),
      ),
    }),
  ]);

  const userById = new Map(userRows.map((u) => [u.id, u]));
  const profileByMembership = new Map(profileRows.map((p) => [p.membershipId, p]));
  const skillsByMembership = new Map<string, string[]>();
  for (const s of skillRows) {
    skillsByMembership.set(s.membershipId, [
      ...(skillsByMembership.get(s.membershipId) ?? []),
      s.skillCode,
    ]);
  }

  return rows.map((r) => {
    const u = userById.get(r.userId)!;
    const p = profileByMembership.get(r.id);
    return {
      userId: r.userId,
      membershipId: r.id,
      role: r.role,
      email: u.email,
      displayName: u.displayName,
      label: personLabel(u),
      weeklyHours: p?.weeklyHours ?? null,
      seniority: hydrateSeniority(p?.seniority),
      skills: hydrateSkills(skillsByMembership.get(r.id) ?? []).map(({ code, label }) => ({
        code,
        label,
      })),
      note: p?.note ?? null,
      hasProfile: p !== undefined,
    };
  });
}

/**
 * Stated weekly availability for members of ONE organisation.
 *
 * Organisation-scoped **by signature**, so one employer's read can never
 * surface another employer's profile. Carries no authorisation of its own — the
 * shape of `getUserRefs`/`getPledgeRef` — so the caller establishes standing
 * first. A user with no profile row is simply ABSENT from the result, and the
 * caller must render that as "no stated availability", never as 0.
 */
export async function getMembershipAvailability(
  organisationId: string,
  userIds: string[],
  exec: Executor = defaultDb,
): Promise<{ userId: string; membershipId: string; weeklyHours: number }[]> {
  if (userIds.length === 0) return [];
  const rows = await exec.query.memberships.findMany({
    where: and(
      eq(memberships.organisationId, organisationId),
      inArray(memberships.userId, [...new Set(userIds)]),
    ),
  });
  if (rows.length === 0) return [];
  const profiles = await exec.query.membershipProfiles.findMany({
    where: inArray(
      membershipProfiles.membershipId,
      rows.map((r) => r.id),
    ),
  });
  const byMembership = new Map(profiles.map((p) => [p.membershipId, p]));
  return rows.flatMap((r) => {
    const p = byMembership.get(r.id);
    return p ? [{ userId: r.userId, membershipId: r.id, weeklyHours: p.weeklyHours }] : [];
  });
}

/**
 * GDPR erasure — every profile this person holds, in every organisation.
 *
 * A skills profile is one-sided, so unlike a US-8.3 message (half of a
 * two-party record) it is DELETED, not redacted. Called by Privacy, which owns
 * the erasure sequence; the skill rows follow via ON DELETE CASCADE.
 */
export async function deleteMembershipProfilesForUser(
  userId: string,
  exec: Executor,
): Promise<void> {
  const rows = await exec.query.memberships.findMany({ where: eq(memberships.userId, userId) });
  if (rows.length === 0) return;
  await exec.delete(membershipProfiles).where(
    inArray(
      membershipProfiles.membershipId,
      rows.map((r) => r.id),
    ),
  );
}
