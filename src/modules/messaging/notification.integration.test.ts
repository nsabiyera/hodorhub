import { describe, it, expect, vi, beforeEach } from 'vitest';
import { eq } from 'drizzle-orm';
import { testDb } from '@/test/db';
import { notifications, outbox } from '@/db/schema';
import {
  registerCharity,
  registerCorporation,
  approveVerification,
  createPlatformAdmin,
  inviteMember,
} from '@/modules/identity';
import { createDraftProject, setResourceNeeds, publishProject } from '@/modules/projects';
import { expressInterest } from '@/modules/commitments';

const sent: { to: string; subject: string; text: string }[] = [];
vi.mock('@/lib/mailer', () => ({
  mailer: {
    send: async (m: { to: string; subject: string; text: string }) => {
      sent.push(m);
    },
  },
}));

import { relayOutbox, setPreference } from '@/modules/notifications';
import { postMessage } from './service';

beforeEach(() => {
  sent.length = 0;
});

const need = {
  skill: 'Backend development',
  role: 'Backend developer',
  kind: 'ongoing' as const,
  quantity: 1,
  hoursPerWeek: 2,
  durationWeeks: 8,
};

const SECRET = 'Our confidential rate is forty thousand pounds';

async function conversation(tag: string) {
  const admin = await createPlatformAdmin(`admin-${tag}@hh.com`, 'admin-password-1', testDb);
  const charity = await registerCharity(
    {
      email: `petra-${tag}@goodcause.org`,
      password: 'a-strong-password',
      charityName: `Good Cause ${tag}`,
      regNumber: `CH-${tag}`,
    },
    testDb,
  );
  await approveVerification(charity.verificationRequestId, admin, testDb);
  const { projectId } = await createDraftProject(
    charity.userId,
    {
      charityOrgId: charity.organisationId,
      title: 'Rebuild the community garden',
      description: 'Rebuild the community garden for the neighbourhood to enjoy again.',
      goal: 'Reopen the garden by spring.',
      category: 'software',
    },
    testDb,
  );
  await setResourceNeeds(charity.userId, projectId, [need], testDb);
  await publishProject(charity.userId, projectId, testDb);

  const corp = await registerCorporation(
    {
      email: `carlos-${tag}@acme-${tag}.com`,
      password: 'another-strong-pw',
      companyName: `Acme ${tag} Ltd`,
      emailDomain: `acme-${tag}.com`,
    },
    testDb,
  );
  await approveVerification(corp.verificationRequestId, admin, testDb);
  await expressInterest(corp.userId, projectId, corp.organisationId, testDb);
  return { admin, charity, corp, projectId };
}

describe('Messaging notifications (US-8.3 x US-8.2)', () => {
  it('tells the other side, never the author', async () => {
    const { charity, corp, projectId } = await conversation('a');
    await postMessage(
      corp.userId,
      projectId,
      { corporationOrgId: corp.organisationId, body: 'Hello from the corporation.' },
      testDb,
    );
    await relayOutbox(testDb);

    const charityNotes = (
      await testDb.query.notifications.findMany({ where: eq(notifications.userId, charity.userId) })
    ).filter((n) => n.type === 'message.posted');
    const corpNotes = (
      await testDb.query.notifications.findMany({ where: eq(notifications.userId, corp.userId) })
    ).filter((n) => n.type === 'message.posted');

    expect(charityNotes).toHaveLength(1);
    // The author already knows what they wrote.
    expect(corpNotes).toHaveLength(0);
  });

  it('tells EVERY role-holder on the other side, not just the first', async () => {
    // With two CSR managers, a `findFirst` would leave one able to read the
    // thread but never told a reply exists.
    const { charity, corp, projectId } = await conversation('b');
    const second = await inviteMember(
      corp.userId,
      corp.organisationId,
      'second-csr@acme-b.com',
      'csr_manager',
      testDb,
    );
    const volunteer = await inviteMember(
      corp.userId,
      corp.organisationId,
      'dana@acme-b.com',
      'volunteer',
      testDb,
    );

    await postMessage(
      charity.userId,
      projectId,
      { corporationOrgId: corp.organisationId, body: 'A reply from the charity.' },
      testDb,
    );
    await relayOutbox(testDb);

    const notifiedFor = async (userId: string) =>
      (
        await testDb.query.notifications.findMany({ where: eq(notifications.userId, userId) })
      ).filter((n) => n.type === 'message.posted').length;

    expect(await notifiedFor(corp.userId)).toBe(1);
    expect(await notifiedFor(second.userId)).toBe(1);
    // A volunteer is not a party to the conversation and is not told about it.
    expect(await notifiedFor(volunteer.userId)).toBe(0);
  });

  it('honours the recipient’s US-8.2 messages preference', async () => {
    const { charity, corp, projectId } = await conversation('c');
    await setPreference(charity.userId, { kind: 'messages', inApp: false, email: false }, testDb);

    // Building the scenario mails people (verification, interest). Clear the
    // spy so this asserts about THIS message and nothing else — otherwise the
    // count is dominated by setup and the test proves very little.
    await relayOutbox(testDb);
    sent.length = 0;

    await postMessage(
      corp.userId,
      projectId,
      { corporationOrgId: corp.organisationId, body: 'You will not hear about this.' },
      testDb,
    );
    await relayOutbox(testDb);

    const notes = (
      await testDb.query.notifications.findMany({ where: eq(notifications.userId, charity.userId) })
    ).filter((n) => n.type === 'message.posted');
    expect(notes).toHaveLength(0);
    expect(sent).toHaveLength(0);
  });

  it('never lets message text escape into a payload, a notification or an email', async () => {
    // This is the test that stops someone re-adding a "preview" later. The
    // message body is private to the two organisations; an outbox row, a
    // notification row and an email are three other places it must not appear.
    const { charity, corp, projectId } = await conversation('d');
    await relayOutbox(testDb);
    sent.length = 0;
    await postMessage(
      corp.userId,
      projectId,
      { corporationOrgId: corp.organisationId, body: SECRET },
      testDb,
    );
    await relayOutbox(testDb);

    const events = await testDb.query.outbox.findMany({
      where: eq(outbox.eventType, 'MessagePosted'),
    });
    expect(events).toHaveLength(1);
    expect(JSON.stringify(events[0]!.payload)).not.toContain('forty thousand');

    const notes = (
      await testDb.query.notifications.findMany({
        where: eq(notifications.userId, charity.userId),
      })
    ).filter((n) => n.type === 'message.posted');
    expect(notes).toHaveLength(1);
    expect(JSON.stringify(notes[0]!.payload)).not.toContain('forty thousand');

    // The email went out (messages default to email on), and says which project
    // without quoting a word of the conversation.
    expect(sent).toHaveLength(1);
    expect(sent[0]!.text).not.toContain('forty thousand');
    expect(sent[0]!.text).toContain('Rebuild the community garden');
  });
});
