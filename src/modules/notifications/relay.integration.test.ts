import { describe, it, expect } from 'vitest';
import { eq } from 'drizzle-orm';
import { testDb } from '@/test/db';
import { outbox, notifications } from '@/db/schema';
import { registerCharity, approveVerification, createPlatformAdmin } from '@/modules/identity';
import { relayOutbox } from './relay';

describe('outbox relay (A1 fix)', () => {
  it('dispatches unpublished events once, marks them published, and is idempotent', async () => {
    const admin = await createPlatformAdmin('alex@hodorhub.com', 'admin-password-1', testDb);
    const res = await registerCharity(
      {
        email: 'petra@goodcause.org',
        password: 'a-strong-password',
        charityName: 'Good Cause',
        regNumber: 'CH-1',
      },
      testDb,
    );
    await approveVerification(res.verificationRequestId, admin, testDb);

    // Before relay: no notifications, events unpublished.
    expect(await testDb.query.notifications.findMany()).toHaveLength(0);
    const unpublishedBefore = (await testDb.query.outbox.findMany()).filter((e) => !e.published);
    expect(unpublishedBefore.length).toBeGreaterThan(0);

    const processed = await relayOutbox(testDb);
    expect(processed).toBe(unpublishedBefore.length);

    // The charity owner got exactly one verified notification.
    const notes = await testDb.query.notifications.findMany({
      where: eq(notifications.userId, res.userId),
    });
    expect(notes.filter((n) => n.type === 'organisation.verified')).toHaveLength(1);

    // All events are now published.
    expect((await testDb.query.outbox.findMany()).every((e) => e.published)).toBe(true);

    // Running again processes nothing and does not double-notify (idempotent).
    const again = await relayOutbox(testDb);
    expect(again).toBe(0);
    const notesAfter = await testDb.query.notifications.findMany({
      where: eq(notifications.userId, res.userId),
    });
    expect(notesAfter.filter((n) => n.type === 'organisation.verified')).toHaveLength(1);
  });

  it('does not create notifications for events that have no consumer', async () => {
    // ProjectPublished etc. have no notification mapping → no rows, still published.
    await testDb
      .insert(outbox)
      .values({ eventType: 'ProjectPublished', payload: { projectId: 'x' } });
    const n = await relayOutbox(testDb);
    expect(n).toBe(1);
    expect(await testDb.query.notifications.findMany()).toHaveLength(0);
  });
});
