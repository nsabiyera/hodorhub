import { describe, it, expect, vi, beforeEach } from 'vitest';
import { eq } from 'drizzle-orm';
import { testDb } from '@/test/db';
import { notifications, notificationPreferences, outbox, users } from '@/db/schema';
import { registerCharity, createPlatformAdmin, approveVerification } from '@/modules/identity';
import { eraseUser } from '@/modules/privacy';

// The relay sends through the platform mailer; capture what it hands over.
const sent: { to: string; subject: string; text: string }[] = [];
const mailerState = { fail: false };
vi.mock('@/lib/mailer', () => ({
  mailer: {
    send: async (m: { to: string; subject: string; text: string }) => {
      if (mailerState.fail) throw new Error('smtp is down');
      sent.push(m);
    },
  },
}));

import { relayOutbox } from './relay';
import {
  NOTIFICATION_KINDS,
  getPreferences,
  setPreference,
  resolveChannels,
  kindForType,
  PreferenceLockedError,
} from './preferences';
import { NOTIFICATION_COPY } from './copy';

beforeEach(() => {
  sent.length = 0;
  mailerState.fail = false;
});

async function charityOwner(tag = 'a') {
  const res = await registerCharity(
    {
      email: `petra-${tag}@goodcause.org`,
      password: 'a-strong-password',
      charityName: `Good Cause ${tag}`,
      regNumber: `CH-${tag}`,
    },
    testDb,
  );
  return res;
}

describe('Notification preferences — the registry (US-8.2)', () => {
  it('routes every notification type to exactly one kind, and no kind invents one', () => {
    const typesInKinds = NOTIFICATION_KINDS.flatMap((k) => k.types);
    // No type is claimed twice — a type in two kinds would make "off" ambiguous.
    expect(new Set(typesInKinds).size).toBe(typesInKinds.length);
    // The copy map and the registry describe the same set of notifications, so
    // a new type cannot be shipped notifiable-but-unclassified, or classified
    // but with no human copy for the email body.
    expect([...typesInKinds].sort()).toEqual(Object.keys(NOTIFICATION_COPY).sort());
    expect(kindForType('hours.approved')?.code).toBe('hours');
    expect(kindForType('nothing.registered')).toBeUndefined();
  });

  it('pins the kind codes, because a rename silently un-silences every user', async () => {
    // These strings live in users' saved rows. Renaming one leaves an orphan row
    // and no row for the new code, so the user quietly reverts to the default.
    // Changing this list must be a deliberate act with a data migration.
    expect(NOTIFICATION_KINDS.map((k) => k.code)).toEqual([
      'verification',
      'interest_and_pledges',
      'hours',
      'gifts',
      'delivery',
      'agent_delivery',
      'messages',
      'membership',
    ]);
    // The two the AC names as essential, and only those two.
    expect(NOTIFICATION_KINDS.filter((k) => k.essential).map((k) => k.code)).toEqual([
      'verification',
      'agent_delivery',
    ]);
  });

  it('an unclassified type still arrives in-app and never emails by accident', async () => {
    const user = await charityOwner();
    const channels = await resolveChannels(testDb, user.userId, 'nothing.registered');
    expect(channels).toEqual({ inApp: true, email: false });
  });
});

describe('Notification preferences — defaults and changes (US-8.2)', () => {
  it('a user who has never touched preferences is on the platform defaults', async () => {
    const user = await charityOwner();
    const prefs = await getPreferences(user.userId, testDb);
    expect(prefs).toHaveLength(NOTIFICATION_KINDS.length);
    expect(prefs.every((p) => p.isDefault)).toBe(true);
    expect(prefs.find((p) => p.code === 'gifts')).toMatchObject({ inApp: true, email: false });
    // No rows were written to get there — absent means default, no backfill.
    expect(await testDb.query.notificationPreferences.findMany()).toHaveLength(0);
  });

  it('changing a kind twice updates one row rather than forking into two', async () => {
    const user = await charityOwner();
    await setPreference(user.userId, { kind: 'gifts', inApp: false, email: false }, testDb);
    await setPreference(user.userId, { kind: 'gifts', inApp: true, email: true }, testDb);
    const rows = await testDb.query.notificationPreferences.findMany({
      where: eq(notificationPreferences.userId, user.userId),
    });
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ kind: 'gifts', inApp: true, email: true });
  });

  it('preferences are one user’s own — changing mine does not touch yours', async () => {
    const mine = await charityOwner('a');
    const yours = await charityOwner('b');
    await setPreference(mine.userId, { kind: 'gifts', inApp: false, email: false }, testDb);
    const yourPrefs = await getPreferences(yours.userId, testDb);
    expect(yourPrefs.find((p) => p.code === 'gifts')).toMatchObject({
      inApp: true,
      isDefault: true,
    });
  });

  it('an essential kind cannot be silenced in-app, but its email can be turned off', async () => {
    const user = await charityOwner();
    await expect(
      setPreference(user.userId, { kind: 'verification', inApp: false, email: false }, testDb),
    ).rejects.toBeInstanceOf(PreferenceLockedError);
    await expect(
      setPreference(user.userId, { kind: 'agent_delivery', inApp: false, email: true }, testDb),
    ).rejects.toBeInstanceOf(PreferenceLockedError);

    // Email off is allowed, and in-app stays on.
    await setPreference(user.userId, { kind: 'verification', inApp: true, email: false }, testDb);
    const prefs = await getPreferences(user.userId, testDb);
    expect(prefs.find((p) => p.code === 'verification')).toMatchObject({
      inApp: true,
      email: false,
      essential: true,
    });
  });

  it('a stale row claiming an essential kind is off is overridden at delivery', async () => {
    const user = await charityOwner();
    // Write the row the domain refuses, as a retired kind or a bad migration might.
    await testDb
      .insert(notificationPreferences)
      .values({ userId: user.userId, kind: 'verification', inApp: false, email: false });
    const channels = await resolveChannels(testDb, user.userId, 'organisation.rejected');
    expect(channels.inApp).toBe(true);
  });
});

describe('Notification preferences — enforced where notifications are created (US-8.2)', () => {
  it('a silenced kind writes NO notification row, rather than hiding one at read time', async () => {
    const silenced = await charityOwner('a');
    const control = await charityOwner('b');
    await setPreference(silenced.userId, { kind: 'hours', inApp: false, email: false }, testDb);

    // Both users get the SAME event shape in the SAME relay batch. Without the
    // control, an empty result would also be produced by the event never being
    // dispatched at all — a renamed payload key, say — and this test would pass
    // green for entirely the wrong reason.
    for (const userId of [silenced.userId, control.userId]) {
      await testDb.insert(outbox).values({
        eventType: 'HoursApproved',
        payload: { hourLogId: 'x', volunteerUserId: userId, reason: null },
      });
    }
    await relayOutbox(testDb);

    const notesFor = async (userId: string) =>
      (
        await testDb.query.notifications.findMany({
          where: eq(notifications.userId, userId),
        })
      ).filter((n) => n.type === 'hours.approved');

    expect(await notesFor(silenced.userId)).toHaveLength(0);
    expect(await notesFor(control.userId)).toHaveLength(1);
    // The one email belongs to the control user, never the silenced one.
    expect(sent.map((m) => m.to)).toEqual(['petra-b@goodcause.org']);
  });

  it('the same event still arrives for a user on the defaults', async () => {
    const user = await charityOwner();
    await testDb.insert(outbox).values({
      eventType: 'HoursApproved',
      payload: { hourLogId: 'x', volunteerUserId: user.userId, reason: null },
    });
    await relayOutbox(testDb);
    const notes = await testDb.query.notifications.findMany({
      where: eq(notifications.userId, user.userId),
    });
    expect(notes.filter((n) => n.type === 'hours.approved')).toHaveLength(1);
    // `hours` defaults to email on, so one email carrying the shared copy.
    expect(sent).toHaveLength(1);
    expect(sent[0]).toMatchObject({
      to: 'petra-a@goodcause.org',
      subject: NOTIFICATION_COPY['hours.approved']!.title,
    });
    expect(sent[0]!.text).toContain('/notifications');
  });

  it('turning email off keeps the in-app notification and sends nothing', async () => {
    const user = await charityOwner();
    await setPreference(user.userId, { kind: 'hours', inApp: true, email: false }, testDb);
    await testDb.insert(outbox).values({
      eventType: 'HoursApproved',
      payload: { volunteerUserId: user.userId },
    });
    await relayOutbox(testDb);
    const notes = await testDb.query.notifications.findMany({
      where: eq(notifications.userId, user.userId),
    });
    expect(notes.filter((n) => n.type === 'hours.approved')).toHaveLength(1);
    expect(sent).toHaveLength(0);
  });

  it('never emails an erased account, even with email switched on', async () => {
    const user = await charityOwner();
    await setPreference(user.userId, { kind: 'hours', inApp: true, email: true }, testDb);
    await testDb.update(users).set({ deletedAt: new Date() }).where(eq(users.id, user.userId));

    await testDb.insert(outbox).values({
      eventType: 'HoursApproved',
      payload: { volunteerUserId: user.userId },
    });
    await relayOutbox(testDb);
    expect(sent).toHaveLength(0);
  });

  it('an essential notification arrives in-app even with the kind row switched off', async () => {
    const admin = await createPlatformAdmin('admin@hodorhub.com', 'admin-password-1', testDb);
    const user = await charityOwner();
    await testDb
      .insert(notificationPreferences)
      .values({ userId: user.userId, kind: 'verification', inApp: false, email: false });

    await approveVerification(user.verificationRequestId, admin, testDb);
    await relayOutbox(testDb);

    const notes = await testDb.query.notifications.findMany({
      where: eq(notifications.userId, user.userId),
    });
    expect(notes.filter((n) => n.type === 'organisation.verified')).toHaveLength(1);
  });
});

describe('Notification preferences — channel independence and failure (US-8.2)', () => {
  it('email-only never points the reader at a page the notification is not on', async () => {
    const user = await charityOwner();
    await setPreference(user.userId, { kind: 'hours', inApp: false, email: true }, testDb);
    await testDb.insert(outbox).values({
      eventType: 'HoursApproved',
      payload: { volunteerUserId: user.userId },
    });
    await relayOutbox(testDb);

    // "Email me, don't clutter my list" is a real choice: the mail is sent and
    // no in-app row is written — so the mail must NOT link to /notifications,
    // which would land the reader on a page that deliberately lacks it.
    const notes = await testDb.query.notifications.findMany({
      where: eq(notifications.userId, user.userId),
    });
    expect(notes.filter((n) => n.type === 'hours.approved')).toHaveLength(0);
    expect(sent).toHaveLength(1);
    expect(sent[0]!.text).not.toContain('/notifications');
    expect(sent[0]!.text).toContain('Your donated time now counts toward the project.');
  });

  it('keeps the in-app notification when the mail server fails', async () => {
    const user = await charityOwner();
    mailerState.fail = true;
    await testDb.insert(outbox).values({
      eventType: 'HoursApproved',
      payload: { volunteerUserId: user.userId },
    });

    // The whole point of sending after commit: a dead mail server must not roll
    // back a notification that was genuinely delivered in-app, nor re-deliver
    // the outbox row. Email is at-most-once; in-app is the record.
    await expect(relayOutbox(testDb)).resolves.toBeGreaterThan(0);
    const notes = await testDb.query.notifications.findMany({
      where: eq(notifications.userId, user.userId),
    });
    expect(notes.filter((n) => n.type === 'hours.approved')).toHaveLength(1);
    const [event] = await testDb.query.outbox.findMany({
      where: eq(outbox.eventType, 'HoursApproved'),
    });
    expect(event?.published).toBe(true);
  });

  it('writes nothing at all for an erased account — not an email, not a row', async () => {
    const user = await charityOwner();
    await testDb.update(users).set({ deletedAt: new Date() }).where(eq(users.id, user.userId));
    await testDb.insert(outbox).values({
      eventType: 'HoursApproved',
      payload: { volunteerUserId: user.userId },
    });
    await relayOutbox(testDb);

    expect(sent).toHaveLength(0);
    const notes = await testDb.query.notifications.findMany({
      where: eq(notifications.userId, user.userId),
    });
    expect(notes).toHaveLength(0);
  });

  it('erasure sweeps the preference rows with everything else', async () => {
    const user = await charityOwner();
    await setPreference(user.userId, { kind: 'gifts', inApp: false, email: false }, testDb);
    expect(
      await testDb.query.notificationPreferences.findMany({
        where: eq(notificationPreferences.userId, user.userId),
      }),
    ).toHaveLength(1);

    await eraseUser(user.userId, testDb);

    expect(
      await testDb.query.notificationPreferences.findMany({
        where: eq(notificationPreferences.userId, user.userId),
      }),
    ).toHaveLength(0);
  });
});
