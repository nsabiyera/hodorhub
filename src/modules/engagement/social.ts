import { and, eq, inArray } from 'drizzle-orm';
import { db as defaultDb } from '@/db';
import { socialConnections, engagementEvents, outbox } from '@/db/schema';
import { encryptSecret } from '@/lib/crypto';
import { findMembership, NotFoundError, ForbiddenError } from '@/modules/identity';
import { getProjectRef } from '@/modules/projects';
import { recomputeProjectScore } from './service';

/**
 * Social ingestion (US-3.4/3.5) — connect FB/X accounts and ingest real post
 * engagement into the support score. Anti-gaming (US-9.3): ingested events enter
 * `provisional`; a trust gate promotes credible ones to `confirmed` (which count)
 * and dampens the rest to `flagged` (which don't). Idempotent by (source,
 * externalEventId) so webhook retries / polling overlap never double-count.
 *
 * This module is app-tier only (connect needs authz → Identity). Ingestion is
 * driven by an admin/system endpoint for the MVP (a Cloud Scheduler → HTTP sync
 * in prod); worker-side ingestion is a later refinement.
 */
type Db = typeof defaultDb;

// Action weights (SUPPORT_SCORE_MODEL §2). Amplification counts most.
const WEIGHTS: Record<string, Record<string, number>> = {
  facebook: { reaction: 1, comment: 2, share: 4 },
  twitter: { like: 1, reply: 2, repost: 4, quote: 4 },
};
function baseWeight(source: string, action: string): number {
  return WEIGHTS[source]?.[action] ?? 1;
}

// Trust below this (0–100) is treated as bot-like / uncredible → dampened.
const TRUST_THRESHOLD = 30;
// More than this many events from ONE actor on a project = bot-like velocity → dampened.
const MAX_EVENTS_PER_ACTOR = 3;

export interface RawEngagementEvent {
  source: 'facebook' | 'twitter';
  action: string;
  actorRef?: string;
  externalEventId: string;
  occurredAt: string; // ISO timestamp from the platform
  trust: number; // 0–100 actor-credibility (age/ratio/behaviour); real derivation is a refinement
}

/** US-3.4 — connect a charity's social account + linked post (token encrypted at rest). */
export async function connectSocialAccount(
  actingUserId: string,
  projectId: string,
  platform: 'facebook' | 'twitter',
  accessToken: string,
  linkedPostRef: string,
  db: Db = defaultDb,
): Promise<{ connectionId: string }> {
  return db.transaction(async (tx) => {
    const ref = await getProjectRef(projectId, tx);
    if (!ref) throw new NotFoundError('Project');
    const m = await findMembership(actingUserId, ref.charityOrgId, tx);
    if (!m) throw new NotFoundError('Project');
    if (m.role !== 'charity_owner') throw new ForbiddenError();

    const [row] = await tx
      .insert(socialConnections)
      .values({
        organisationId: ref.charityOrgId,
        platform,
        tokenCiphertext: encryptSecret(accessToken),
        linkedPostRef,
      })
      .returning({ id: socialConnections.id });
    await tx
      .insert(outbox)
      .values({ eventType: 'SocialAccountConnected', payload: { projectId, platform } });
    return { connectionId: row!.id };
  });
}

/** US-3.5 — ingest raw engagement into `engagement_events` as provisional (idempotent). */
export async function ingestEngagement(
  projectId: string,
  events: RawEngagementEvent[],
  db: Db = defaultDb,
): Promise<{ ingested: number }> {
  return db.transaction(async (tx) => {
    let ingested = 0;
    for (const e of events) {
      const bw = baseWeight(e.source, e.action);
      const trust = Math.max(0, Math.min(100, Math.round(e.trust)));
      const effectiveValue = Math.round((bw * trust) / 100);
      const res = await tx
        .insert(engagementEvents)
        .values({
          projectId,
          source: e.source,
          action: e.action,
          actorRef: e.actorRef ?? null,
          externalEventId: e.externalEventId,
          baseWeight: bw,
          trust,
          effectiveValue,
          status: 'provisional',
          occurredAt: new Date(e.occurredAt),
        })
        .onConflictDoNothing() // (source, external_event_id) unique → no double-count
        .returning({ id: engagementEvents.id });
      if (res.length > 0) ingested += 1;
    }
    return { ingested };
  });
}

/**
 * US-9.3 anti-gaming pass: promote provisional events to `confirmed` when they
 * are both trustworthy (trust ≥ threshold) AND not part of a bot-like burst (an
 * actor flooding one project past MAX_EVENTS_PER_ACTOR); dampen the rest to
 * `flagged`. Then rescore. (The per-source cap lives in Scoring §4.)
 */
export async function confirmPendingEngagement(
  projectId: string,
  db: Db = defaultDb,
  threshold: number = TRUST_THRESHOLD,
): Promise<{ confirmed: number; flagged: number }> {
  return db.transaction(async (tx) => {
    const pending = await tx.query.engagementEvents.findMany({
      where: and(
        eq(engagementEvents.projectId, projectId),
        eq(engagementEvents.status, 'provisional'),
      ),
    });

    // Velocity/bot detection: actors with too many events on this project.
    const perActor = new Map<string, number>();
    for (const e of pending) {
      if (e.actorRef) perActor.set(e.actorRef, (perActor.get(e.actorRef) ?? 0) + 1);
    }
    const botActors = new Set(
      [...perActor].filter(([, n]) => n > MAX_EVENTS_PER_ACTOR).map(([a]) => a),
    );

    const confirmIds: string[] = [];
    const flagIds: string[] = [];
    for (const e of pending) {
      const trustworthy =
        e.trust >= threshold && !(e.actorRef !== null && botActors.has(e.actorRef));
      (trustworthy ? confirmIds : flagIds).push(e.id);
    }

    if (confirmIds.length > 0) {
      await tx
        .update(engagementEvents)
        .set({ status: 'confirmed' })
        .where(inArray(engagementEvents.id, confirmIds));
    }
    if (flagIds.length > 0) {
      await tx
        .update(engagementEvents)
        .set({ status: 'flagged' })
        .where(inArray(engagementEvents.id, flagIds));
    }

    await recomputeProjectScore(tx, projectId);
    return { confirmed: confirmIds.length, flagged: flagIds.length };
  });
}
