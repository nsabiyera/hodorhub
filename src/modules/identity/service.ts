import { randomUUID } from 'node:crypto';
import { and, asc, eq, inArray } from 'drizzle-orm';
import { z } from 'zod';
import { personLabel } from './profile';
import { db as defaultDb } from '@/db';
import {
  organisations,
  users,
  memberships,
  verificationRequests,
  outbox,
  orgType,
  orgStatus,
} from '@/db/schema';
import { hashPassword, verifyPassword } from '@/lib/password';
import {
  EmailInUseError,
  InvalidWorkEmailError,
  InvalidCredentialsError,
  NotFoundError,
  InvalidStateError,
  NotVerifiedError,
  ForbiddenError,
} from './errors';

/**
 * Identity & Org service — US-1.1 (charity registration), US-1.2 (corporation
 * registration), US-1.3 (verification). All state changes are transactional and
 * emit a domain event to the outbox (ARCHITECTURE.md §8) in the same transaction.
 *
 * `db` is injected (defaults to the shared client) so integration tests can pass
 * a transaction-scoped handle.
 */
type Db = typeof defaultDb;
// A transaction handle (what db.transaction hands the callback). Query builders
// work on either a Db or a Tx, so helpers accept the union.
type Tx = Parameters<Parameters<Db['transaction']>[0]>[0];
type Executor = Db | Tx;

const email = z
  .string()
  .email()
  .max(320)
  .transform((s) => s.toLowerCase());
const password = z.string().min(10).max(200);

export const registerCharitySchema = z.object({
  email,
  password,
  charityName: z.string().min(2).max(200),
  regNumber: z.string().min(1).max(50),
});
export type RegisterCharityInput = z.infer<typeof registerCharitySchema>;

export const registerCorporationSchema = z.object({
  email,
  password,
  companyName: z.string().min(2).max(200),
  // The verified work-email domain (US-1.2). The registrant's email must match.
  emailDomain: z
    .string()
    .min(3)
    .max(255)
    .transform((s) => s.toLowerCase().replace(/^@/, '')),
});
export type RegisterCorporationInput = z.infer<typeof registerCorporationSchema>;

export interface RegistrationResult {
  userId: string;
  organisationId: string;
  verificationRequestId: string;
}

async function createUser(
  tx: Executor,
  addr: string,
  pw: string,
  isAdmin = false,
): Promise<string> {
  const existing = await tx.query.users.findFirst({ where: eq(users.email, addr) });
  if (existing) throw new EmailInUseError();
  const [row] = await tx
    .insert(users)
    .values({
      email: addr,
      passwordHash: await hashPassword(pw),
      isPlatformAdmin: isAdmin,
      consentedAt: new Date(), // GDPR consent captured at signup
    })
    .returning({ id: users.id });
  return row!.id;
}

async function registerOrg(
  db: Db,
  args: {
    orgType: 'charity' | 'corporation';
    name: string;
    regNumber: string | null;
    email: string;
    password: string;
    role: 'charity_owner' | 'csr_manager';
    eventType: string;
  },
): Promise<RegistrationResult> {
  return db.transaction(async (tx) => {
    const userId = await createUser(tx, args.email, args.password);
    const [org] = await tx
      .insert(organisations)
      .values({ type: args.orgType, name: args.name, regNumber: args.regNumber, status: 'pending' })
      .returning({ id: organisations.id });
    await tx.insert(memberships).values({ userId, organisationId: org!.id, role: args.role });
    const [vr] = await tx
      .insert(verificationRequests)
      .values({ organisationId: org!.id, status: 'pending' })
      .returning({ id: verificationRequests.id });
    await tx.insert(outbox).values({
      eventType: args.eventType,
      payload: { organisationId: org!.id, type: args.orgType },
    });
    return { userId, organisationId: org!.id, verificationRequestId: vr!.id };
  });
}

/** US-1.1 — register a charity; org starts in `pending` verification state. */
export async function registerCharity(
  input: RegisterCharityInput,
  db: Db = defaultDb,
): Promise<RegistrationResult> {
  const v = registerCharitySchema.parse(input);
  return registerOrg(db, {
    orgType: 'charity',
    name: v.charityName,
    regNumber: v.regNumber,
    email: v.email,
    password: v.password,
    role: 'charity_owner',
    eventType: 'CharityRegistered',
  });
}

/** US-1.2 — register a corporation; the registrant's email must be on the work domain. */
export async function registerCorporation(
  input: RegisterCorporationInput,
  db: Db = defaultDb,
): Promise<RegistrationResult> {
  const v = registerCorporationSchema.parse(input);
  const domain = v.email.split('@')[1];
  if (domain !== v.emailDomain) throw new InvalidWorkEmailError(v.emailDomain);
  return registerOrg(db, {
    orgType: 'corporation',
    name: v.companyName,
    regNumber: null,
    email: v.email,
    password: v.password,
    role: 'csr_manager',
    eventType: 'CorporationRegistered',
  });
}

/** US-1.3 — the admin verification queue. */
export function listPendingVerifications(db: Db = defaultDb) {
  return db.query.verificationRequests.findMany({
    where: eq(verificationRequests.status, 'pending'),
  });
}

/** US-1.3 — approve: org becomes `verified`; emits OrganisationVerified. */
export function approveVerification(
  requestId: string,
  reviewerId: string,
  db: Db = defaultDb,
): Promise<void> {
  return decideVerification(db, requestId, reviewerId, 'verified', null);
}

/** US-1.3 — reject: org becomes `rejected` with a reason; owner is notified. */
export async function rejectVerification(
  requestId: string,
  reviewerId: string,
  reason: string,
  db: Db = defaultDb,
): Promise<void> {
  if (!reason?.trim()) throw new InvalidStateError('A rejection reason is required.');
  return decideVerification(db, requestId, reviewerId, 'rejected', reason.trim());
}

async function decideVerification(
  db: Db,
  requestId: string,
  reviewerId: string,
  outcome: 'verified' | 'rejected',
  reason: string | null,
): Promise<void> {
  await db.transaction(async (tx) => {
    const request = await tx.query.verificationRequests.findFirst({
      where: eq(verificationRequests.id, requestId),
    });
    if (!request) throw new NotFoundError('Verification request');
    if (request.status !== 'pending') {
      throw new InvalidStateError(`Request already ${request.status}.`);
    }

    await tx
      .update(verificationRequests)
      .set({ status: outcome, reviewerId, reason })
      .where(eq(verificationRequests.id, requestId));
    await tx
      .update(organisations)
      .set({ status: outcome })
      .where(eq(organisations.id, request.organisationId));

    // Owner notification (US-8.1) is produced by the Notifications relay from
    // this event — no inline write (single source of notifications).
    await tx.insert(outbox).values({
      eventType: outcome === 'verified' ? 'OrganisationVerified' : 'OrganisationRejected',
      payload: { organisationId: request.organisationId, reason },
    });
  });
}

/**
 * Guard used by downstream modules (e.g. Projects) to enforce US-1.1:
 * an unverified organisation cannot publish. Throws NotVerifiedError otherwise.
 */
export async function assertOrganisationVerified(
  organisationId: string,
  db: Executor = defaultDb,
): Promise<void> {
  const org = await db.query.organisations.findFirst({
    where: eq(organisations.id, organisationId),
  });
  if (!org) throw new NotFoundError('Organisation');
  if (org.status !== 'verified') throw new NotVerifiedError();
}

/** Verify credentials for login. Returns the user id or throws. */
export async function authenticate(
  rawEmail: string,
  rawPassword: string,
  db: Db = defaultDb,
): Promise<{ userId: string; isPlatformAdmin: boolean }> {
  const addr = rawEmail.toLowerCase();
  const user = await db.query.users.findFirst({ where: eq(users.email, addr) });
  if (!user) {
    // Do a dummy verify to keep timing roughly constant against user enumeration.
    await verifyPassword(
      '$argon2id$v=19$m=19456,t=2,p=1$AAAAAAAAAAAAAAAAAAAAAA$'.padEnd(90, 'A'),
      rawPassword,
    ).catch(() => false);
    throw new InvalidCredentialsError();
  }
  if (!(await verifyPassword(user.passwordHash, rawPassword))) throw new InvalidCredentialsError();
  return { userId: user.id, isPlatformAdmin: user.isPlatformAdmin };
}

/** Test/bootstrap helper — create a platform admin. Not exposed via HTTP. */
export async function createPlatformAdmin(
  rawEmail: string,
  rawPassword: string,
  db: Db = defaultDb,
): Promise<string> {
  return createUser(db, rawEmail.toLowerCase(), rawPassword, true);
}

/** Read a membership (used to check a user belongs to / role within an org). */
export function findMembership(userId: string, organisationId: string, db: Executor = defaultDb) {
  return db.query.memberships.findFirst({
    where: and(eq(memberships.userId, userId), eq(memberships.organisationId, organisationId)),
  });
}

/**
 * Resolve a user's single membership joined to its organisation — used by the
 * app layer to role-gate UI. Returns null if the user has no membership
 * (a platform admin or supporter-only account).
 */
export async function getUserOrg(userId: string, db: Executor = defaultDb) {
  const m = await db.query.memberships.findFirst({
    where: eq(memberships.userId, userId),
    // ORDERED, deliberately. Without it Postgres may return a different
    // membership on different calls, so a multi-organisation user would see
    // one employer on one page and another on the next — and (US-1.5) could
    // save their availability against a different employer each time. The
    // choice is still arbitrary until there is an organisation switcher, but
    // it is at least STABLE and the same everywhere.
    orderBy: [asc(memberships.id)],
  });
  if (!m) return null;
  const org = await db.query.organisations.findFirst({
    where: eq(organisations.id, m.organisationId),
  });
  if (!org) return null;
  return {
    organisationId: org.id,
    role: m.role,
    orgType: org.type,
    status: org.status,
  };
}

type MemberRole = 'charity_owner' | 'csr_manager' | 'manager' | 'volunteer';

/**
 * US-1.4 (minimal) — an org admin invites a colleague by email with a role.
 * If the email is unknown a user is created with an unusable random password
 * (they set one via password reset — tracked deferral). Idempotent per (user, org).
 */
export async function inviteMember(
  actingUserId: string,
  organisationId: string,
  email: string,
  role: MemberRole,
  db: Db = defaultDb,
): Promise<{ userId: string; membershipCreated: boolean }> {
  const addr = z.string().email().parse(email).toLowerCase();
  return db.transaction(async (tx) => {
    const actor = await findMembership(actingUserId, organisationId, tx);
    if (!actor) throw new NotFoundError('Organisation');
    if (actor.role !== 'csr_manager' && actor.role !== 'charity_owner') throw new ForbiddenError();

    const existing = await tx.query.users.findFirst({ where: eq(users.email, addr) });
    let userId: string;
    if (existing) {
      userId = existing.id;
    } else {
      const [u] = await tx
        .insert(users)
        .values({ email: addr, passwordHash: await hashPassword(randomUUID() + randomUUID()) })
        .returning({ id: users.id });
      userId = u!.id;
    }

    if (await findMembership(userId, organisationId, tx))
      return { userId, membershipCreated: false };
    await tx.insert(memberships).values({ userId, organisationId, role });
    await tx
      .insert(outbox)
      .values({ eventType: 'MemberInvited', payload: { organisationId, userId, role } });
    return { userId, membershipCreated: true };
  });
}

/** Is this user a platform admin? (Used by Moderation/Admin authz.) */
export async function isPlatformAdmin(userId: string, db: Executor = defaultDb): Promise<boolean> {
  const u = await db.query.users.findFirst({
    where: eq(users.id, userId),
    columns: { isPlatformAdmin: true },
  });
  return u?.isPlatformAdmin ?? false;
}

/** Find a user in an org holding a given role (e.g. the charity_owner to notify). */
export async function findOrgMemberByRole(
  organisationId: string,
  role: 'charity_owner' | 'csr_manager' | 'manager' | 'volunteer',
  db: Executor = defaultDb,
): Promise<string | null> {
  const m = await db.query.memberships.findFirst({
    where: and(eq(memberships.organisationId, organisationId), eq(memberships.role, role)),
  });
  return m?.userId ?? null;
}

/**
 * US-10.7 — how many seats an organisation is using. A seat is a membership;
 * an invited user who has never signed in still holds one, because the seat is
 * the access, not the activity.
 */
export async function countMembers(organisationId: string, exec: Executor = defaultDb) {
  const rows = await exec.query.memberships.findMany({
    where: eq(memberships.organisationId, organisationId),
    columns: { id: true },
  });
  return rows.length;
}

/** US-10.7 — who holds this organisation's seats. Members only. */
export async function listMembers(
  actingUserId: string,
  organisationId: string,
  db: Db = defaultDb,
) {
  const actor = await findMembership(actingUserId, organisationId, db);
  if (!actor) throw new NotFoundError('Organisation');
  const rows = await db.query.memberships.findMany({
    where: eq(memberships.organisationId, organisationId),
  });
  if (rows.length === 0) return [];
  // One batched read, not one per member: this was an N+1 that grew with the
  // roster, and US-1.5 puts it behind a page that lists everyone.
  const memberUsers = await db.query.users.findMany({
    where: inArray(
      users.id,
      rows.map((m) => m.userId),
    ),
    columns: { id: true, email: true, displayName: true, deletedAt: true },
  });
  const byId = new Map(memberUsers.map((u) => [u.id, u]));
  return rows.map((m) => {
    const u = byId.get(m.userId);
    return {
      userId: m.userId,
      role: m.role,
      // The admin keeps the email: it is the key they invited by and the only
      // way to re-invite or contact someone (US-1.5).
      email: u?.email ?? null,
      displayName: u?.displayName ?? null,
      label: u ? personLabel(u) : 'Former member',
    };
  });
}

/**
 * US-10.7 — release a seat. Refuses to remove the last admin of an
 * organisation: an org with no csr_manager or charity_owner can never invite
 * anyone again, so that is a state the platform must not be able to reach.
 */
export async function removeMember(
  actingUserId: string,
  organisationId: string,
  targetUserId: string,
  db: Db = defaultDb,
): Promise<void> {
  await db.transaction(async (tx) => {
    const actor = await findMembership(actingUserId, organisationId, tx);
    if (!actor) throw new NotFoundError('Organisation');
    if (actor.role !== 'csr_manager' && actor.role !== 'charity_owner') throw new ForbiddenError();

    const target = await findMembership(targetUserId, organisationId, tx);
    if (!target) throw new NotFoundError('Member');

    if (target.role === 'csr_manager' || target.role === 'charity_owner') {
      const admins = await tx.query.memberships.findMany({
        where: eq(memberships.organisationId, organisationId),
      });
      const remaining = admins.filter(
        (m) =>
          m.userId !== targetUserId && (m.role === 'csr_manager' || m.role === 'charity_owner'),
      );
      if (remaining.length === 0)
        throw new InvalidStateError('An organisation must keep at least one administrator.');
    }

    await tx
      .delete(memberships)
      .where(
        and(eq(memberships.organisationId, organisationId), eq(memberships.userId, targetUserId)),
      );
  });
}

/**
 * US-8.3 — batched name lookup for organisations the caller already has a
 * legitimate reference to (a conversation list, say). Batched rather than
 * per-id so a list of N conversations is one query, not N.
 *
 * Identity owns `organisations`, so this is where a name is read from. Before
 * this existed, Discovery joined the table inline — that is pre-existing debt,
 * not a pattern to copy.
 *
 * Carries no authorisation: an organisation's name and type are shown publicly
 * on every project page. Callers still establish standing for whatever they are
 * naming.
 */
export async function getOrganisationRefs(
  ids: string[],
  exec: Executor = defaultDb,
): Promise<
  {
    id: string;
    name: string;
    type: (typeof orgType.enumValues)[number];
    status: (typeof orgStatus.enumValues)[number];
  }[]
> {
  if (ids.length === 0) return [];
  return exec.query.organisations.findMany({
    where: inArray(organisations.id, [...new Set(ids)]),
    columns: { id: true, name: true, type: true, status: true },
  });
}

/**
 * US-8.3 — batched author lookup for a conversation. Identity owns `users`, so
 * a message's author label is read from here rather than Messaging reaching
 * into the table.
 *
 * Returns the email, which is all there is to identify a person until US-1.5
 * gives users a display name. Callers must already have established that the
 * viewer may see these people.
 */
export async function getUserRefs(
  ids: string[],
  exec: Executor = defaultDb,
): Promise<
  { id: string; email: string; displayName: string | null; label: string; erased: boolean }[]
> {
  if (ids.length === 0) return [];
  const rows = await exec.query.users.findMany({
    where: inArray(users.id, [...new Set(ids)]),
    columns: { id: true, email: true, displayName: true, deletedAt: true },
  });
  // `label` is derived HERE rather than by each caller: US-8.3's authorLabel and
  // US-6.3's board would otherwise each carry their own copy of "how a person
  // is named", and one of them would drift.
  return rows.map((u) => ({
    id: u.id,
    email: u.email,
    displayName: u.displayName,
    label: personLabel(u),
    erased: u.deletedAt !== null,
  }));
}
