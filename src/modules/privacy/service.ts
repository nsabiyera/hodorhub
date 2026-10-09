import { eq, lt } from 'drizzle-orm';
import { db as defaultDb } from '@/db';
import {
  users,
  authTokens,
  notifications,
  notificationPreferences,
  onPlatformSupports,
  engagementEvents,
} from '@/db/schema';
import { NotFoundError } from '@/modules/identity';
import { recomputeProjectScore } from '@/modules/engagement';
import { redactMessagesByAuthor } from '@/modules/messaging';

/**
 * Privacy (GDPR) — right-to-erasure and data retention. A cross-cutting concern
 * that, by necessity, touches several modules' tables to erase a subject's data;
 * it re-derives affected scores via Engagement rather than recomputing inline.
 * (Consent is captured at signup — users.consentedAt.)
 */
type Db = typeof defaultDb;

/**
 * Right-to-erasure: anonymise the user and delete their personal data. Records
 * that must survive for others' legitimate reporting (approved hours, pledges)
 * are retained but no longer tied to identifiable personal data. Their public
 * support is removed and affected project scores are re-derived.
 */
export async function eraseUser(userId: string, db: Db = defaultDb): Promise<void> {
  await db.transaction(async (tx) => {
    const user = await tx.query.users.findFirst({ where: eq(users.id, userId) });
    if (!user) throw new NotFoundError('User');

    // Collect projects the user supported so we can re-score them after removal.
    const supports = await tx.query.onPlatformSupports.findMany({
      where: eq(onPlatformSupports.userId, userId),
    });
    const affectedProjects = [...new Set(supports.map((s) => s.projectId))];

    await tx.delete(onPlatformSupports).where(eq(onPlatformSupports.userId, userId));
    await tx.delete(authTokens).where(eq(authTokens.userId, userId));
    await tx.delete(notifications).where(eq(notifications.userId, userId));
    // Every user-scoped table belongs here. When a new one is added (US-8.2
    // added this; US-8.3 will add messages), it must be swept too — the FKs are
    // ON DELETE no action, so nothing else reaps these rows.
    await tx.delete(notificationPreferences).where(eq(notificationPreferences.userId, userId));
    // US-8.3 messages are REDACTED, not deleted: a message is one half of a
    // two-party negotiation, and deleting it would gut the other
    // organisation's record of what was agreed. The row, its order and its org
    // attribution survive; the person's words do not.
    await redactMessagesByAuthor(userId, tx);

    // Anonymise the account (email kept unique + unusable; password unusable).
    await tx
      .update(users)
      .set({
        email: `erased-${userId}@erased.invalid`,
        passwordHash: 'erased',
        emailVerifiedAt: null,
        isPlatformAdmin: false,
        deletedAt: new Date(),
      })
      .where(eq(users.id, userId));

    for (const projectId of affectedProjects) {
      await recomputeProjectScore(tx, projectId);
    }
  });
}

/**
 * Retention: purge ingested social engagement (third-party PII) older than the
 * cutoff, then re-derive affected project scores. Intended to run on a schedule
 * in the worker.
 */
export async function purgeEngagementOlderThan(
  cutoff: Date,
  db: Db = defaultDb,
): Promise<{ purged: number }> {
  return db.transaction(async (tx) => {
    const stale = await tx
      .select({ id: engagementEvents.id, projectId: engagementEvents.projectId })
      .from(engagementEvents)
      .where(lt(engagementEvents.occurredAt, cutoff));
    if (stale.length === 0) return { purged: 0 };

    const affected = [...new Set(stale.map((e) => e.projectId))];
    await tx.delete(engagementEvents).where(lt(engagementEvents.occurredAt, cutoff));
    for (const projectId of affected) {
      await recomputeProjectScore(tx, projectId);
    }
    return { purged: stale.length };
  });
}
