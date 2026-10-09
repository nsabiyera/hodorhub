import { and, desc, eq, lt } from 'drizzle-orm';
import { z } from 'zod';
import { db as defaultDb } from '@/db';
import { messageThreads, messages, outbox } from '@/db/schema';
import {
  DomainError,
  NotFoundError,
  findMembership,
  getOrganisationRefs,
  getUserRefs,
  assertOrganisationVerified,
} from '@/modules/identity';
import { getProjectRef } from '@/modules/projects';
import {
  hasCorporateRelationship,
  listRelatedCorporationsForProject,
  type RelationshipSignal,
} from '@/modules/commitments';

/**
 * Messaging — US-8.3. One conversation per (project, corporation), the same
 * thread before, during and after delivery.
 *
 * This context owns `message_threads` and `messages` and nothing else. It never
 * queries another module's tables: "does this corporation have a relationship
 * with this project" is Commitments' single definition, and organisation names
 * come from Identity. Enforced structurally by `boundary.test.ts`.
 */

type Db = typeof defaultDb;
type Tx = Parameters<Parameters<Db['transaction']>[0]>[0];
type Executor = Db | Tx;

/**
 * A corporation with no relationship to the project is refused — but with 403,
 * not 404. The AC's 404 is about *outsiders*; a CSR manager asking about their
 * own corporation's conversation on a public project learns nothing from a 403
 * they did not already know, and it lets the UI render the actionable prompt
 * ("express interest, pledge, or fund a compute budget to start talking").
 */
export class NoRelationshipError extends DomainError {
  constructor() {
    super(
      'Your organisation has no relationship with this project yet. Express interest, pledge resources, offer a resource gift or fund a compute budget to start a conversation.',
      'no_relationship',
    );
  }
}

/** A `before` cursor that is not a whole, non-negative number. 400, not 500. */
export class InvalidCursorError extends DomainError {
  constructor() {
    super('That is not a valid position in the conversation.', 'invalid_cursor');
  }
}

export const messageSchema = z.object({
  corporationOrgId: z.string().uuid(),
  body: z.string().trim().min(1).max(4000),
});
export type MessageInput = z.infer<typeof messageSchema>;

interface ThreadParticipant {
  projectId: string;
  projectTitle: string;
  charityOrgId: string;
  corporationOrgId: string;
  side: 'charity' | 'corporation';
  actingOrgId: string;
}

/**
 * Establish that this user may take part in the (project, corporation)
 * conversation at all.
 *
 * Check order matters and is not incidental:
 *   1. the project must exist,
 *   2. membership of either side — anything else is a 404 that says nothing,
 *   3. and ONLY THEN the relationship question.
 *
 * Step 3 last is what keeps Commitments' unauthenticated relationship read from
 * becoming a disclosure surface: a stranger is turned away before it is asked.
 *
 * A platform admin gets 404 through the *absence of a bypass* — they hold no
 * membership in either organisation, so both branches miss and they receive the
 * same error object as any other outsider. There is deliberately no admin
 * branch here, and no `bypass` parameter, ever.
 */
async function loadParticipant(
  exec: Executor,
  userId: string,
  projectId: string,
  corporationOrgId: string,
): Promise<ThreadParticipant> {
  const project = await getProjectRef(projectId, exec);
  if (!project) throw new NotFoundError('Conversation');

  const base = {
    projectId: project.id,
    projectTitle: project.title,
    charityOrgId: project.charityOrgId,
    corporationOrgId,
  };

  // BOTH memberships are resolved, not one-or-the-other. Someone can hold a
  // row in each organisation — a CSR manager who also volunteers at the charity
  // is entirely ordinary — and short-circuiting on "has any charity membership"
  // would drop them through both branches into a 404 on their own conversation.
  const [asCharity, asCorp] = await Promise.all([
    findMembership(userId, project.charityOrgId, exec),
    findMembership(userId, corporationOrgId, exec),
  ]);

  // Roles are deliberately narrow: these threads carry pledge negotiation, and
  // an allocated volunteer reading their employer's commercial conversation
  // with the charity is a leak nobody asked for. Widening is a one-line change;
  // narrowing after people have read each other's messages is not.
  //
  // Charity ownership wins when someone is both: it is the side that owns the
  // project, so it is the stronger claim.
  let side: 'charity' | 'corporation';
  let actingOrgId: string;
  if (asCharity?.role === 'charity_owner') {
    side = 'charity';
    actingOrgId = project.charityOrgId;
  } else if (asCorp?.role === 'csr_manager') {
    side = 'corporation';
    actingOrgId = corporationOrgId;
  } else {
    throw new NotFoundError('Conversation');
  }

  // A draft project is not visible to a corporation at all, so answering
  // "no relationship" here would confirm that a project id exists. The charity
  // side legitimately sees its own drafts.
  if (side === 'corporation' && project.status === 'draft') {
    throw new NotFoundError('Conversation');
  }

  if (!(await hasCorporateRelationship(projectId, corporationOrgId, exec))) {
    throw new NoRelationshipError();
  }

  return { ...base, side, actingOrgId };
}

/** Entry by thread id — the read path. Same rules, resolved from the row. */
async function loadParticipantByThread(
  exec: Executor,
  userId: string,
  threadId: string,
): Promise<ThreadParticipant & { threadId: string }> {
  const thread = await exec.query.messageThreads.findFirst({
    where: eq(messageThreads.id, threadId),
  });
  if (!thread) throw new NotFoundError('Conversation');
  const p = await loadParticipant(exec, userId, thread.projectId, thread.corporationOrgId);
  return { ...p, threadId };
}

export interface MessageView {
  id: string;
  /** Empty when redacted — the UI branches on `redacted`, never on this. */
  body: string;
  redacted: boolean;
  authorOrgId: string;
  authorOrgName: string;
  authorLabel: string;
  isMine: boolean;
  isMySide: boolean;
  postedAt: Date;
  seq: number;
}

export interface ThreadView {
  threadId: string;
  project: { id: string; title: string };
  charityOrgName: string;
  corporationOrgId: string;
  corporationName: string;
  viewer: {
    side: 'charity' | 'corporation';
    organisationId: string;
    canPost: boolean;
    /** Why not, when canPost is false — so the UI can say something true. */
    cannotPostReason: string | null;
  };
  /** The window, ALWAYS oldest-first. */
  messages: MessageView[];
  /** Older messages exist above this window. */
  hasMore: boolean;
  /** Pass back as `before` to walk backwards; null when there is no more. */
  nextBefore: number | null;
}

const PAGE_SIZE = 50;

/**
 * One thread's messages.
 *
 * "Oldest-first" is a **rendering** order, not a fetch order. We fetch the
 * NEWEST page (`ORDER BY seq DESC`) and reverse it, because the naive
 * `ORDER BY seq ASC LIMIT 50` also satisfies the words "oldest-first" and is
 * wrong: a long thread would open on the first message anyone ever wrote and
 * never show today's.
 *
 * Paging is keyset on `seq`, not `OFFSET`: offsets shift as new messages are
 * appended, so a reader walking back would silently skip or repeat rows.
 */
export async function getThread(
  actingUserId: string,
  threadId: string,
  opts: { limit?: number; before?: number } = {},
  db: Db = defaultDb,
): Promise<ThreadView> {
  const p = await loadParticipantByThread(db, actingUserId, threadId);
  const limit = Math.min(Math.max(opts.limit ?? PAGE_SIZE, 1), PAGE_SIZE);
  // `seq` is a bigint column and drizzle passes a JS number straight through,
  // so a fractional or absurd cursor reaches Postgres as invalid text and the
  // query throws a 500. Validated here rather than only in the route, so the
  // page and any future caller get the same answer.
  if (opts.before !== undefined && (!Number.isSafeInteger(opts.before) || opts.before < 0)) {
    throw new InvalidCursorError();
  }

  // One extra row is the "is there more?" probe, dropped before rendering.
  const rows = await db.query.messages.findMany({
    where:
      opts.before === undefined
        ? eq(messages.threadId, threadId)
        : and(eq(messages.threadId, threadId), lt(messages.seq, opts.before)),
    orderBy: [desc(messages.seq)],
    limit: limit + 1,
  });
  const hasMore = rows.length > limit;
  const window = hasMore ? rows.slice(0, limit) : rows;
  // Captured BEFORE the reverse below. `rows` is newest-first, so the oldest
  // kept row is the last one — and that seq is the cursor for the page above
  // this one. Reading it off `window[0]` after the in-place reverse happens to
  // give the same answer today, but couples two lines that do not look coupled:
  // a `toReversed()` or a reordered object literal would silently make every
  // "load earlier" page return the rows we just showed.
  const oldestSeq = window.at(-1)?.seq ?? null;

  const orgIds = [p.charityOrgId, p.corporationOrgId, ...window.map((m) => m.authorOrgId)];
  const orgRefs = await getOrganisationRefs(orgIds, db);
  const orgs = new Map(orgRefs.map((o) => [o.id, o.name]));

  // `canPost` has to be computed, not assumed: posting requires the
  // CORPORATION to be verified whichever side is writing, so a hard-coded
  // `true` would render a composer the domain then refuses — an error about
  // somebody else's paperwork on an action we said was available.
  const corpVerified = orgRefs.find((o) => o.id === p.corporationOrgId)?.status === 'verified';

  const authorIds = window.map((m) => m.authorUserId);
  // US-1.5 — `label` is Identity's one definition of how a person is named:
  // a display name, else the email, else 'Former member' for an erased author.
  const authors = new Map((await getUserRefs(authorIds, db)).map((u) => [u.id, u.label]));

  return {
    threadId,
    project: { id: p.projectId, title: p.projectTitle },
    charityOrgName: orgs.get(p.charityOrgId) ?? 'Charity',
    corporationOrgId: p.corporationOrgId,
    corporationName: orgs.get(p.corporationOrgId) ?? 'Corporation',
    viewer: {
      side: p.side,
      organisationId: p.actingOrgId,
      canPost: corpVerified,
      cannotPostReason: corpVerified
        ? null
        : `${orgs.get(p.corporationOrgId) ?? 'This organisation'} is not verified yet, so the conversation is not open.`,
    },
    // Reversed here: fetched newest-first, rendered oldest-first.
    messages: window.reverse().map((m) => ({
      id: m.id,
      body: m.redactedAt ? '' : m.body,
      redacted: m.redactedAt !== null,
      authorOrgId: m.authorOrgId,
      authorOrgName: orgs.get(m.authorOrgId) ?? 'Unknown',
      // `authorLabel` is the seam: when US-1.5 gives users a display name this
      // becomes that name, with no other change anywhere.
      authorLabel: authors.get(m.authorUserId) ?? 'Former member',
      isMine: m.authorUserId === actingUserId,
      isMySide: m.authorOrgId === p.actingOrgId,
      postedAt: m.createdAt,
      seq: m.seq,
    })),
    hasMore,
    nextBefore: hasMore ? oldestSeq : null,
  };
}

/**
 * Post a message, creating the thread on first use.
 *
 * There is deliberately no "start a conversation" call: a thread row is created
 * inside this transaction or not at all, so an empty thread — a row asserting a
 * conversation nobody has had — cannot exist.
 *
 * The corporation must be **verified** to post. `expressInterest` has no
 * verification gate, so without this an unverified corporation could open a
 * channel into a charity's inbox with one cheap POST. Reads stay open, so
 * history is never lost if an organisation's status changes later.
 */
export async function postMessage(
  actingUserId: string,
  projectId: string,
  input: MessageInput,
  db: Db = defaultDb,
): Promise<{ threadId: string; messageId: string }> {
  const v = messageSchema.parse(input);
  return db.transaction(async (tx) => {
    const p = await loadParticipant(tx, actingUserId, projectId, v.corporationOrgId);
    await assertOrganisationVerified(v.corporationOrgId, tx);

    // `onConflictDoUpdate`, never `onConflictDoNothing`: DO NOTHING returns zero
    // rows on conflict, which is the classic bug that turns "the second person
    // posts" into a crash. The update also does real work.
    const [thread] = await tx
      .insert(messageThreads)
      .values({ projectId, corporationOrgId: v.corporationOrgId, lastMessageAt: new Date() })
      .onConflictDoUpdate({
        target: [messageThreads.projectId, messageThreads.corporationOrgId],
        set: { lastMessageAt: new Date() },
      })
      .returning({ id: messageThreads.id });
    const threadId = thread!.id;

    const [message] = await tx
      .insert(messages)
      .values({
        threadId,
        authorUserId: actingUserId,
        authorOrgId: p.actingOrgId,
        body: v.body,
      })
      .returning({ id: messages.id });

    // The payload carries the PROJECT title, never the message body: a preview
    // would put private words into two more jsonb stores with their own
    // lifetimes and into an email, which is a third channel the AC's "visible
    // to both organisations and nobody else" does not cover.
    await tx.insert(outbox).values({
      eventType: 'MessagePosted',
      payload: {
        messageId: message!.id,
        threadId,
        projectId,
        title: p.projectTitle,
        charityOrgId: p.charityOrgId,
        corporationOrgId: v.corporationOrgId,
        authorUserId: actingUserId,
        authorOrgId: p.actingOrgId,
      },
    });

    return { threadId, messageId: message!.id };
  });
}

export interface ConversationSummary {
  /** null until the first message — the thread row does not exist yet. */
  threadId: string | null;
  corporationOrgId: string;
  corporationName: string;
  signals: RelationshipSignal[];
  lastMessageAt: Date | null;
  canPost: boolean;
}

/**
 * The conversations this caller may see on a project. A charity owner gets one
 * entry per related corporation (including those with no messages yet, so there
 * is something to start); a CSR manager gets at most their own.
 *
 * Never throws for a non-participant — it returns `[]`, so any page may call it
 * without a try/catch. Same contract as Delivery's `findWorkspaceForParticipant`.
 */
export async function listConversationsForProject(
  actingUserId: string,
  projectId: string,
  db: Db = defaultDb,
): Promise<ConversationSummary[]> {
  const project = await getProjectRef(projectId, db);
  if (!project) return [];

  // Standing FIRST, then Commitments. `listRelatedCorporationsForProject`
  // carries no authorisation of its own, and who has expressed interest in a
  // project is charity-only information — so an arbitrary caller must not be
  // able to trigger that read at all, even though the result is discarded.
  const asCharity = await findMembership(actingUserId, project.charityOrgId, db);
  const isCharityOwner = asCharity?.role === 'charity_owner';

  const related = await listRelatedCorporationsForProject(projectId, db);
  if (related.length === 0) return [];

  let visible: typeof related;
  if (isCharityOwner) {
    visible = related;
  } else {
    const mine = [];
    for (const r of related) {
      const m = await findMembership(actingUserId, r.corporationOrgId, db);
      if (m?.role === 'csr_manager') mine.push(r);
    }
    visible = mine;
  }
  if (visible.length === 0) return [];

  const threads = await db.query.messageThreads.findMany({
    where: eq(messageThreads.projectId, projectId),
  });
  const byCorp = new Map(threads.map((t) => [t.corporationOrgId, t]));
  const orgRefs = await getOrganisationRefs(
    visible.map((r) => r.corporationOrgId),
    db,
  );
  const orgs = new Map(orgRefs.map((o) => [o.id, o.name]));
  // Posting needs the corporation verified, whichever side writes. Computed,
  // not assumed, so the panel never offers a composer the domain would refuse.
  const verified = new Set(orgRefs.filter((o) => o.status === 'verified').map((o) => o.id));

  return visible.map((r) => {
    const thread = byCorp.get(r.corporationOrgId);
    return {
      threadId: thread?.id ?? null,
      corporationOrgId: r.corporationOrgId,
      corporationName: orgs.get(r.corporationOrgId) ?? 'Unknown',
      signals: r.signals,
      lastMessageAt: thread?.lastMessageAt ?? null,
      canPost: verified.has(r.corporationOrgId),
    };
  });
}

/**
 * GDPR erasure (US-2.5). The body is blanked and tombstoned rather than the row
 * deleted: a message is one half of a two-party negotiation, and deleting it
 * would gut the *other* organisation's record of what was agreed. The row,
 * ordering, org attribution and timestamps survive; the person's words do not.
 *
 * Called by Privacy, which owns the erasure sequence.
 */
export async function redactMessagesByAuthor(userId: string, exec: Executor): Promise<void> {
  await exec
    .update(messages)
    .set({ body: '', redactedAt: new Date() })
    .where(eq(messages.authorUserId, userId));
}
