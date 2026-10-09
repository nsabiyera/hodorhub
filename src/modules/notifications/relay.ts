import { asc, eq } from 'drizzle-orm';
import { db as defaultDb } from '@/db';
import { outbox } from '@/db/schema';
import { mailer } from '@/lib/mailer';
import { dispatchEvent, type EmailIntent } from './service';

type Db = typeof defaultDb;

// Agent-delivery events that make a run runnable again (Slice 3a Task 6): once
// published, the pg-boss worker should enqueue an `agent.advance` job for the
// run named in the payload. Notifications dispatch is unaffected — this is a
// second, additive subscriber on the same outbox rows.
const RUNNABLE_AGENT_DELIVERY_EVENTS = new Set([
  'ComputePledgeAccepted',
  'MilestoneApproved',
  'MilestoneChangesRequested',
  'RunStatusChanged',
]);

/**
 * Transactional-outbox relay (ARCHITECTURE.md §8). Claims a batch of unpublished
 * events with FOR UPDATE SKIP LOCKED (so multiple relay workers don't collide),
 * dispatches each to the Notifications consumer, and marks them published — all
 * in one transaction. Returns how many were processed. Idempotent across runs:
 * once published, an event is never re-dispatched.
 *
 * `onAgentDeliveryEvent` is an optional, additive hook (default no-op): for the
 * runnable-making agent-delivery events it is invoked with `payload.runId` so a
 * pg-boss worker can enqueue `agent.advance`. The callback only enqueues — it
 * must not run a phase itself — so calling it inside this transaction is safe.
 *
 * `onPromotionRequested` is the same arrangement for US-11.8: a charity owner's
 * ProductionPromotionRequested is handed to the worker, which owns the
 * privileged deployer, as an `agent.promote` enqueue. Deliberately a second
 * hook rather than a widening of the first — a promotion is not a run advance
 * and must never reach the agent path.
 *
 * Emails (US-8.2) are collected during the transaction and sent **after** it
 * commits: a rolled-back batch must never mail anyone, and a mail-server
 * failure must never roll back a notification that was genuinely delivered
 * in-app. A failed send is logged and dropped — real retry belongs with real
 * SMTP (TECH_DEBT), and this is the same mailer the auth emails already use.
 */
export async function relayOutbox(
  db: Db = defaultDb,
  limit = 100,
  onAgentDeliveryEvent: (runId: string) => void = () => {},
  onPromotionRequested: (promotionId: string) => void = () => {},
): Promise<number> {
  // Filled inside the transaction, flushed after it commits. If the callback
  // below is ever made retryable (serialisation-failure retry is the obvious
  // future change), this MUST be cleared at the top of each attempt or every
  // queued email is sent once per attempt.
  const emails: EmailIntent[] = [];
  const processed = await db.transaction(async (tx) => {
    const rows = await tx
      .select()
      .from(outbox)
      .where(eq(outbox.published, false))
      .orderBy(asc(outbox.createdAt))
      .limit(limit)
      .for('update', { skipLocked: true });

    for (const row of rows) {
      const payload = (row.payload ?? {}) as Record<string, unknown>;
      await dispatchEvent(tx, { eventType: row.eventType, payload }, (message) =>
        emails.push(message),
      );
      if (RUNNABLE_AGENT_DELIVERY_EVENTS.has(row.eventType) && typeof payload.runId === 'string') {
        onAgentDeliveryEvent(payload.runId);
      }
      if (
        row.eventType === 'ProductionPromotionRequested' &&
        typeof payload.promotionId === 'string'
      ) {
        onPromotionRequested(payload.promotionId);
      }
      await tx.update(outbox).set({ published: true }).where(eq(outbox.id, row.id));
    }
    return rows.length;
  });

  for (const message of emails) {
    try {
      await mailer.send(message);
    } catch (e) {
      // Email is at-most-once and lossy; the in-app notification is the record.
      // Log enough to identify what was dropped, so it can be replayed by hand.
      console.error('Notification email failed', {
        to: message.to,
        subject: message.subject,
        error: e,
      });
    }
  }
  return processed;
}
