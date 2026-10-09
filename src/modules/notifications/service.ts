import { and, desc, eq } from 'drizzle-orm';
import { db as defaultDb } from '@/db';
import { notifications, memberships, projects, users } from '@/db/schema';
import { env } from '@/config/env';
import { NOTIFICATION_COPY, type NotificationPayload, type NotificationType } from './copy';
import { resolveChannels } from './preferences';

/**
 * Notifications — owns the `notifications` table and turns domain events
 * (delivered by the outbox relay, ARCHITECTURE.md §8) into in-app notifications.
 *
 * This consumer is intentionally self-contained: it resolves recipients via
 * lightweight read-only queries rather than importing sibling services, so the
 * worker bundle stays free of heavy/native deps (e.g. argon2). Those reads are
 * the pragmatic exception for an event consumer / read side.
 */
type Db = typeof defaultDb;
type Tx = Parameters<Parameters<Db['transaction']>[0]>[0];
type Executor = Db | Tx;

type Role = 'charity_owner' | 'csr_manager' | 'manager' | 'volunteer';

async function orgMember(
  exec: Executor,
  organisationId: string,
  role: Role,
): Promise<string | null> {
  const m = await exec.query.memberships.findFirst({
    where: and(eq(memberships.organisationId, organisationId), eq(memberships.role, role)),
  });
  return m?.userId ?? null;
}

/**
 * US-8.3 — EVERY member of an organisation holding a role, not just the first.
 *
 * `orgMember` above is a `findFirst`, so with two CSR managers only one is ever
 * told. For a decision ("your pledge was accepted") one decision-maker is
 * defensible; for a *conversation* it is not — the other person can open the
 * thread and read the reply but is never told it exists.
 *
 * Deliberately a second helper rather than a change to `orgMember`: widening
 * every existing notification type is its own change with its own blast radius
 * (logged as a follow-up), not a side effect of shipping messaging.
 */
async function orgMembers(exec: Executor, organisationId: string, role: Role): Promise<string[]> {
  const rows = await exec.query.memberships.findMany({
    where: and(eq(memberships.organisationId, organisationId), eq(memberships.role, role)),
    columns: { userId: true },
  });
  return rows.map((r) => r.userId);
}

async function charityOrgOf(exec: Executor, projectId: string): Promise<string | null> {
  const p = await exec.query.projects.findFirst({
    where: eq(projects.id, projectId),
    columns: { charityOrgId: true },
  });
  return p?.charityOrgId ?? null;
}

/** One email the caller should send AFTER the relay transaction commits. */
export interface EmailIntent {
  to: string;
  subject: string;
  text: string;
}

interface DispatchCtx {
  exec: Executor;
  queueEmail: (message: EmailIntent) => void;
}

/**
 * Deliver one notification to one user, on the channels that user actually
 * wants (US-8.2).
 *
 * The preference is enforced *here*, where the notification is created, not
 * filtered at read time: a silenced notification should never sit unread in
 * the database waiting to be counted by something else.
 *
 * Email is only ever **queued**. Sending inside the relay transaction would put
 * a network call in a transaction and, worse, could mail about an event that
 * then rolled back — so the relay flushes the queue after it commits.
 */
async function create(
  ctx: DispatchCtx,
  userId: string | null,
  type: NotificationType,
  payload: unknown,
) {
  if (!userId) return;

  // An erased account accrues nothing at all — not an email, and not an in-app
  // row either. GDPR erasure keeps the `users` row and sweeps this user's
  // notifications once; writing fresh ones afterwards would quietly refill the
  // table with event payloads about someone who asked to be forgotten.
  const user = await ctx.exec.query.users.findFirst({
    where: eq(users.id, userId),
    columns: { email: true, deletedAt: true },
  });
  if (!user || user.deletedAt) return;

  const channels = await resolveChannels(ctx.exec, userId, type);
  if (channels.inApp) await ctx.exec.insert(notifications).values({ userId, type, payload });
  if (!channels.email) return;

  const copy = NOTIFICATION_COPY[type];
  // Only send someone to /notifications when a copy is actually waiting there.
  // The two channels are independent on purpose — "email me, don't clutter my
  // list" is a real preference — so with in-app off this link would land the
  // reader on a page that deliberately does not hold the notification.
  const tail = channels.inApp
    ? `

Read it on HodorHub: ${env.PUBLIC_BASE_URL}/notifications`
    : '';
  ctx.queueEmail({
    to: user.email,
    subject: copy.title,
    text: `${copy.title}

${copy.body((payload ?? {}) as NotificationPayload)}${tail}`,
  });
}

interface DomainEvent {
  eventType: string;
  payload: Record<string, unknown>;
}

/** A user's notifications, newest first (US-8.1). */
export function listForUser(userId: string, db: Db = defaultDb) {
  return db.query.notifications.findMany({
    where: eq(notifications.userId, userId),
    orderBy: [desc(notifications.createdAt)],
    limit: 50,
  });
}

/**
 * Map one domain event to the notification(s) it produces. Unknown events no-op.
 *
 * `queueEmail` collects the emails this event should produce (US-8.2); the
 * caller sends them after its transaction commits. Default no-op, so existing
 * callers that only care about in-app notifications need no change.
 */
export async function dispatchEvent(
  exec: Executor,
  event: DomainEvent,
  queueEmail: (message: EmailIntent) => void = () => {},
): Promise<void> {
  const ctx: DispatchCtx = { exec, queueEmail };
  const p = event.payload;
  switch (event.eventType) {
    case 'OrganisationVerified':
    case 'OrganisationRejected': {
      const orgId = p.organisationId as string;
      const owner =
        (await orgMember(exec, orgId, 'charity_owner')) ??
        (await orgMember(exec, orgId, 'csr_manager'));
      await create(
        ctx,
        owner,
        event.eventType === 'OrganisationVerified'
          ? 'organisation.verified'
          : 'organisation.rejected',
        p,
      );
      break;
    }
    case 'InterestExpressed':
    case 'PledgeProposed': {
      const charityOrg = await charityOrgOf(exec, p.projectId as string);
      if (charityOrg) {
        const owner = await orgMember(exec, charityOrg, 'charity_owner');
        await create(
          ctx,
          owner,
          event.eventType === 'InterestExpressed' ? 'interest.expressed' : 'pledge.proposed',
          p,
        );
      }
      break;
    }
    case 'PledgeAccepted':
    case 'PledgeDeclined': {
      const csr = await orgMember(exec, p.corporationOrgId as string, 'csr_manager');
      await create(
        ctx,
        csr,
        event.eventType === 'PledgeAccepted' ? 'pledge.accepted' : 'pledge.declined',
        p,
      );
      break;
    }
    case 'HoursApproved':
    case 'HoursRejected': {
      await create(
        ctx,
        (p.volunteerUserId as string) ?? null,
        event.eventType === 'HoursApproved' ? 'hours.approved' : 'hours.rejected',
        p,
      );
      break;
    }
    case 'VolunteerOverAllocated': {
      // US-1.5 — the volunteer alone. Their manager made the call knowingly and
      // saw the flag; the charity must never learn an employee's availability.
      await create(ctx, (p.volunteerUserId as string) ?? null, 'hours.over_allocated', p);
      break;
    }
    case 'DeliveryTaskAssigned': {
      // US-6.3 — a coordinator put a task on a volunteer. The volunteer is the
      // only one told: the coordinator already knows, they did it.
      await create(ctx, (p.volunteerUserId as string) ?? null, 'delivery_task.assigned', p);
      break;
    }
    case 'DeliveryMilestoneAchieved': {
      // US-6.3 — the charity confirmed a milestone. The delivering corporation
      // is told, because confirmation is the charity's call, not theirs.
      const csr = await orgMember(exec, p.corporationOrgId as string, 'csr_manager');
      await create(ctx, csr, 'delivery_milestone.achieved', p);
      break;
    }
    case 'MemberInvited': {
      await create(ctx, p.userId as string, 'member.invited', p);
      break;
    }
    case 'ResourceGiftOffered':
    case 'ResourceGiftProvided': {
      const charityOrg = await charityOrgOf(exec, p.projectId as string);
      if (charityOrg) {
        const owner = await orgMember(exec, charityOrg, 'charity_owner');
        await create(
          ctx,
          owner,
          event.eventType === 'ResourceGiftOffered'
            ? 'resource_gift.offered'
            : 'resource_gift.provided',
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
      await create(ctx, csr, type, p);
      break;
    }
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
      await create(ctx, owner, type, p);
      await create(ctx, csr, type, p);
      break;
    }
    case 'MessagePosted': {
      // Only the OTHER side is told: a ping because a teammate sent a message
      // is noise, and the author already knows what they wrote.
      const authorOrgId = p.authorOrgId as string;
      const charityOrgId = p.charityOrgId as string;
      const toCharity = authorOrgId !== charityOrgId;
      const recipientOrgId = toCharity ? charityOrgId : (p.corporationOrgId as string);
      const role = toCharity ? 'charity_owner' : 'csr_manager';
      for (const userId of await orgMembers(exec, recipientOrgId, role)) {
        if (userId === p.authorUserId) continue;
        await create(ctx, userId, 'message.posted', p);
      }
      break;
    }
    case 'ProductionPromoted': {
      // US-11.8 — the app the charity approved is now live in production. Both
      // parties are told: the charity because it is their app and their
      // decision, the funding corporation because their compute delivered it.
      const owner = await orgMember(exec, p.charityOrgId as string, 'charity_owner');
      const csr = await orgMember(exec, p.corporationOrgId as string, 'csr_manager');
      await create(ctx, owner, 'agent_run.promoted', p);
      await create(ctx, csr, 'agent_run.promoted', p);
      break;
    }
    default:
      break; // ProjectPublished, ProjectStatusChanged, ProjectSupported, ResourceGiftWithdrawn, RunClosed, MilestoneApproved, etc. → no notification
  }
}
