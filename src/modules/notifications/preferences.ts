import { and, eq } from 'drizzle-orm';
import { z } from 'zod';
import { db as defaultDb } from '@/db';
import { notificationPreferences } from '@/db/schema';
import { DomainError } from '@/modules/identity/errors';
import type { NotificationType } from './copy';

/**
 * US-8.2 — notification preferences.
 *
 * Users choose by **kind**, not by event type: nobody should have to manage
 * twenty slugs to stop being pinged about gifts. This registry is the single
 * authority for which kinds exist, which types belong to each, what the
 * platform default is, and which kinds are essential. Everything else — the
 * table, the zod enum on the route, the settings UI — derives from it (the
 * US-11.12 rule: one registry, no drifting copies).
 *
 * A user with no rows is on the defaults. Absent means default, so no user
 * needs a row and no backfill is ever required.
 *
 * **`code` is append-only.** It is stored as free text in every user's saved
 * row, so renaming one orphans those rows silently: the user's "off" becomes an
 * unmatched row, the new code has none, and they are back on the default —
 * un-silenced, with nothing failing to tell anyone. Retire a kind by removing
 * it and migrating its rows, never by renaming it in place. `kind-codes are
 * a data contract` is pinned by a test.
 */
export interface NotificationKind {
  code: string;
  label: string;
  description: string;
  /**
   * Every notification type this kind covers. Typed against the copy map, so a
   * kind cannot claim a type that has no human copy — and the partition test
   * only has to prove the other direction (no type left unclassified).
   */
  types: NotificationType[];
  /**
   * Essential kinds cannot have their **in-app** channel turned off. A charity
   * that has not seen "verification declined" cannot act at all, and an agent
   * run is spending a corporation's money on a charity's app — a pause or halt
   * stops delivery. Nobody should be able to configure themselves into missing
   * a decision only they can make. Email stays theirs to switch off.
   */
  essential: boolean;
  defaults: { inApp: boolean; email: boolean };
}

export const NOTIFICATION_KINDS: NotificationKind[] = [
  {
    code: 'verification',
    label: 'Account & verification',
    description: 'Whether your organisation is verified — nothing else works until it is.',
    types: ['organisation.verified', 'organisation.rejected'],
    essential: true,
    defaults: { inApp: true, email: true },
  },
  {
    code: 'interest_and_pledges',
    label: 'Interest & pledges',
    description: 'A corporation shows interest, pledges, or has its pledge answered.',
    types: ['interest.expressed', 'pledge.proposed', 'pledge.accepted', 'pledge.declined'],
    essential: false,
    defaults: { inApp: true, email: true },
  },
  {
    code: 'hours',
    label: 'Donated hours',
    description: 'Your logged hours are approved or declined.',
    types: ['hours.approved', 'hours.rejected'],
    essential: false,
    defaults: { inApp: true, email: true },
  },
  {
    code: 'gifts',
    label: 'Resource gifts',
    description: 'In-kind resource gifts offered, answered, provided or received.',
    types: [
      'resource_gift.offered',
      'resource_gift.accepted',
      'resource_gift.declined',
      'resource_gift.provided',
      'resource_gift.received',
    ],
    essential: false,
    // Chatty and low-stakes individually: in-app by default, email opt-in.
    defaults: { inApp: true, email: false },
  },
  {
    code: 'delivery',
    label: 'Delivery board',
    description: 'Tasks assigned to you and milestones the charity confirms.',
    types: ['delivery_task.assigned', 'delivery_milestone.achieved'],
    essential: false,
    defaults: { inApp: true, email: false },
  },
  {
    code: 'agent_delivery',
    label: 'Agent delivery',
    description: 'A funded agent-delivery run is paused, resumed, halted or promoted live.',
    types: ['agent_run.paused', 'agent_run.resumed', 'agent_run.halted', 'agent_run.promoted'],
    essential: true,
    defaults: { inApp: true, email: true },
  },
  {
    code: 'messages',
    label: 'Messages',
    description: 'Replies in a project conversation (US-8.3).',
    types: ['message.posted'],
    essential: false,
    defaults: { inApp: true, email: true },
  },
  {
    code: 'membership',
    label: 'Team & membership',
    description: 'You are invited into an organisation.',
    types: ['member.invited'],
    essential: false,
    defaults: { inApp: true, email: true },
  },
];

export const NOTIFICATION_KIND_CODES = NOTIFICATION_KINDS.map((k) => k.code);

const KIND_BY_TYPE = new Map<string, NotificationKind>(
  NOTIFICATION_KINDS.flatMap((k) => k.types.map((t) => [t, k] as const)),
);

/** The kind a notification type belongs to, or undefined if it is not routed. */
export function kindForType(type: string): NotificationKind | undefined {
  return KIND_BY_TYPE.get(type);
}

export const preferenceUpdateSchema = z.object({
  kind: z.enum(NOTIFICATION_KIND_CODES as [string, ...string[]]),
  inApp: z.boolean(),
  email: z.boolean(),
});
export type PreferenceUpdateInput = z.infer<typeof preferenceUpdateSchema>;

type Db = typeof defaultDb;
type Tx = Parameters<Parameters<Db['transaction']>[0]>[0];
type Executor = Db | Tx;

export interface ChannelChoice {
  inApp: boolean;
  email: boolean;
}

/**
 * What actually happens for one user and one notification type.
 *
 * A type with no kind (an event nobody has classified) falls back to in-app
 * only: a new notification type must never be silently swallowed because
 * someone forgot to register it, and must never start emailing by accident.
 */
export async function resolveChannels(
  exec: Executor,
  userId: string,
  type: string,
): Promise<ChannelChoice> {
  const kind = kindForType(type);
  if (!kind) return { inApp: true, email: false };
  const row = await exec.query.notificationPreferences.findFirst({
    where: and(
      eq(notificationPreferences.userId, userId),
      eq(notificationPreferences.kind, kind.code),
    ),
  });
  if (!row) return { ...kind.defaults };
  // An essential kind is always delivered in-app, whatever a stale row says.
  return { inApp: kind.essential ? true : row.inApp, email: row.email };
}

/** Every kind with this user's effective settings, for the preferences UI. */
export async function getPreferences(userId: string, db: Db = defaultDb) {
  const rows = await db.query.notificationPreferences.findMany({
    where: eq(notificationPreferences.userId, userId),
  });
  const byKind = new Map(rows.map((r) => [r.kind, r]));
  return NOTIFICATION_KINDS.map((k) => {
    const row = byKind.get(k.code);
    return {
      code: k.code,
      label: k.label,
      description: k.description,
      essential: k.essential,
      inApp: k.essential ? true : (row?.inApp ?? k.defaults.inApp),
      email: row?.email ?? k.defaults.email,
      isDefault: !row,
    };
  });
}

/**
 * US-8.2 — an essential kind's in-app channel cannot be switched off. 422, not
 * 403: the request is well-formed and the user owns these settings; this
 * particular value is not one the platform allows.
 */
export class PreferenceLockedError extends DomainError {
  constructor(message: string) {
    super(message, 'preference_locked');
  }
}

/**
 * Change one kind for the signed-in user. Upsert on (user, kind) so a user's
 * settings can never fork into two rows for the same kind.
 */
export async function setPreference(
  userId: string,
  input: PreferenceUpdateInput,
  db: Db = defaultDb,
): Promise<void> {
  const v = preferenceUpdateSchema.parse(input);
  const kind = NOTIFICATION_KINDS.find((k) => k.code === v.kind)!;
  if (kind.essential && !v.inApp)
    throw new PreferenceLockedError(
      `"${kind.label}" always arrives in-app — it carries decisions only you can make. You can still turn its email off.`,
    );

  await db
    .insert(notificationPreferences)
    .values({ userId, kind: v.kind, inApp: v.inApp, email: v.email })
    .onConflictDoUpdate({
      target: [notificationPreferences.userId, notificationPreferences.kind],
      set: { inApp: v.inApp, email: v.email, updatedAt: new Date() },
    });
}
