import { describe, it, expect } from 'vitest';
import { eq } from 'drizzle-orm';
import { testDb } from '@/test/db';
import { messageThreads, messages } from '@/db/schema';
import {
  registerCharity,
  registerCorporation,
  approveVerification,
  createPlatformAdmin,
  inviteMember,
  NotFoundError,
  NotVerifiedError,
} from '@/modules/identity';
import { createDraftProject, setResourceNeeds, publishProject } from '@/modules/projects';
import { expressInterest, pledgeResources, acceptPledge } from '@/modules/commitments';
import { eraseUser } from '@/modules/privacy';
import {
  postMessage,
  getThread,
  listConversationsForProject,
  NoRelationshipError,
  InvalidCursorError,
} from './service';

const need = {
  skill: 'Backend development',
  role: 'Backend developer',
  kind: 'ongoing' as const,
  quantity: 1,
  hoursPerWeek: 2,
  durationWeeks: 8,
};

/** A verified charity with a published project. */
async function charityWithProject(tag = 'a') {
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
  return { admin, charity, projectId };
}

/** A verified corporation. `verified` is a knob so the gate can be tested. */
async function corporation(tag: string, admin: string, verified = true) {
  const corp = await registerCorporation(
    {
      email: `carlos-${tag}@acme-${tag}.com`,
      password: 'another-strong-pw',
      companyName: `Acme ${tag} Ltd`,
      emailDomain: `acme-${tag}.com`,
    },
    testDb,
  );
  if (verified) await approveVerification(corp.verificationRequestId, admin, testDb);
  return corp;
}

describe('Messaging — the relationship gate (US-8.3)', () => {
  it('refuses a corporation with no relationship, and admits one that expressed interest', async () => {
    const { admin, charity, projectId } = await charityWithProject();
    const stranger = await corporation('stranger', admin);

    // A charity's inbox is not open to every corporation on the platform.
    await expect(
      postMessage(
        stranger.userId,
        projectId,
        { corporationOrgId: stranger.organisationId, body: 'Hello!' },
        testDb,
      ),
    ).rejects.toBeInstanceOf(NoRelationshipError);

    await expressInterest(stranger.userId, projectId, stranger.organisationId, testDb);
    const { threadId } = await postMessage(
      stranger.userId,
      projectId,
      { corporationOrgId: stranger.organisationId, body: 'Now we have talked.' },
      testDb,
    );
    expect(threadId).toBeTruthy();
    void charity;
  });

  it('counts each of the four signals on its own', async () => {
    // One corporation holding all four signals would prove nothing about three
    // of them: four corporations, one signal each.
    const { admin, charity, projectId } = await charityWithProject('sig');

    const viaInterest = await corporation('i', admin);
    await expressInterest(viaInterest.userId, projectId, viaInterest.organisationId, testDb);

    const viaPledge = await corporation('p', admin);
    await pledgeResources(
      viaPledge.userId,
      projectId,
      {
        corporationOrgId: viaPledge.organisationId,
        resourceType: 'Dev time',
        quantity: 2,
        durationWeeks: 8,
      },
      testDb,
    );

    for (const corp of [viaInterest, viaPledge]) {
      await expect(
        postMessage(
          corp.userId,
          projectId,
          { corporationOrgId: corp.organisationId, body: 'Hello from a signal.' },
          testDb,
        ),
      ).resolves.toMatchObject({ threadId: expect.any(String) });
    }

    // And the charity sees both conversations, one per corporation.
    const list = await listConversationsForProject(charity.userId, projectId, testDb);
    expect(list.map((c) => c.corporationOrgId).sort()).toEqual(
      [viaInterest.organisationId, viaPledge.organisationId].sort(),
    );
    expect(list.find((c) => c.corporationOrgId === viaInterest.organisationId)?.signals).toEqual([
      'interest',
    ]);
    expect(list.find((c) => c.corporationOrgId === viaPledge.organisationId)?.signals).toEqual([
      'pledge',
    ]);
  });

  it('keeps the conversation alive after a pledge is declined', async () => {
    // A decline must not strand a thread both parties could read yesterday.
    const { admin, charity, projectId } = await charityWithProject('dec');
    const corp = await corporation('dec', admin);
    const { pledgeId } = await pledgeResources(
      corp.userId,
      projectId,
      {
        corporationOrgId: corp.organisationId,
        resourceType: 'Dev time',
        quantity: 2,
        durationWeeks: 8,
      },
      testDb,
    );
    const { threadId } = await postMessage(
      corp.userId,
      projectId,
      { corporationOrgId: corp.organisationId, body: 'We would like to help.' },
      testDb,
    );

    const { declinePledge } = await import('@/modules/commitments');
    await declinePledge(charity.userId, pledgeId, 'Not this time', testDb);

    const view = await getThread(corp.userId, threadId, {}, testDb);
    expect(view.messages).toHaveLength(1);
    await expect(
      postMessage(
        corp.userId,
        projectId,
        { corporationOrgId: corp.organisationId, body: 'May I ask why?' },
        testDb,
      ),
    ).resolves.toBeTruthy();
  });

  it('refuses an unverified corporation on the post path', async () => {
    const { admin, projectId } = await charityWithProject('unv');
    const corp = await corporation('unv', admin, false);
    await expressInterest(corp.userId, projectId, corp.organisationId, testDb);

    // expressInterest has no verification gate, so without this an unverified
    // corporation could open a channel into a charity's inbox with one POST.
    await expect(
      postMessage(
        corp.userId,
        projectId,
        { corporationOrgId: corp.organisationId, body: 'Let me in.' },
        testDb,
      ),
    ).rejects.toBeInstanceOf(NotVerifiedError);
  });
});

describe('Messaging — one thread per (project, corporation) (US-8.3)', () => {
  it('is the same thread before, during and after delivery', async () => {
    const { admin, charity, projectId } = await charityWithProject('life');
    const corp = await corporation('life', admin);
    await expressInterest(corp.userId, projectId, corp.organisationId, testDb);

    const first = await postMessage(
      corp.userId,
      projectId,
      { corporationOrgId: corp.organisationId, body: 'Interested in this.' },
      testDb,
    );
    const reply = await postMessage(
      charity.userId,
      projectId,
      { corporationOrgId: corp.organisationId, body: 'Great — tell us more.' },
      testDb,
    );
    expect(reply.threadId).toBe(first.threadId);

    // Move into delivery: a pledge, accepted, creating a workspace.
    const { pledgeId } = await pledgeResources(
      corp.userId,
      projectId,
      {
        corporationOrgId: corp.organisationId,
        resourceType: 'Dev time',
        quantity: 2,
        durationWeeks: 8,
      },
      testDb,
    );
    await acceptPledge(charity.userId, pledgeId, testDb);

    const during = await postMessage(
      charity.userId,
      projectId,
      { corporationOrgId: corp.organisationId, body: 'Work has started.' },
      testDb,
    );
    expect(during.threadId).toBe(first.threadId);
    expect(
      await testDb.query.messageThreads.findMany({
        where: eq(messageThreads.projectId, projectId),
      }),
    ).toHaveLength(1);
  });

  it('the unique constraint is real, not just an artefact of get-or-create', async () => {
    // Posting only through postMessage would pass with NO index at all, because
    // get-or-create finds the existing row. Only a raw duplicate insert proves
    // the constraint exists.
    const { admin, projectId } = await charityWithProject('uniq');
    const corp = await corporation('uniq', admin);
    await expressInterest(corp.userId, projectId, corp.organisationId, testDb);
    await postMessage(
      corp.userId,
      projectId,
      { corporationOrgId: corp.organisationId, body: 'First.' },
      testDb,
    );

    // Drizzle wraps the driver error, so the SQLSTATE is on `cause`. Asserting
    // the constraint by NAME as well: a bare "it threw" would also be satisfied
    // by a null violation or a bad column, which would prove nothing about
    // one-thread-per-corporation.
    await expect(
      testDb.insert(messageThreads).values({ projectId, corporationOrgId: corp.organisationId }),
    ).rejects.toMatchObject({
      cause: { code: '23505', constraint: 'message_threads_one_per_corporation' },
    });
  });

  it('two simultaneous first posts make one thread, not two', async () => {
    const { admin, charity, projectId } = await charityWithProject('race');
    const corp = await corporation('race', admin);
    await expressInterest(corp.userId, projectId, corp.organisationId, testDb);

    // Promise.all, not allSettled: `onConflictDoUpdate` exists precisely so
    // NEITHER call fails, so a rejection must fail this test. With allSettled
    // and `ok.length > 0`, one call dying on a 23505 would still pass — the
    // exact vacuity this project has been bitten by before.
    await Promise.all([
      postMessage(
        corp.userId,
        projectId,
        { corporationOrgId: corp.organisationId, body: 'From the corporation.' },
        testDb,
      ),
      postMessage(
        charity.userId,
        projectId,
        { corporationOrgId: corp.organisationId, body: 'From the charity.' },
        testDb,
      ),
    ]);
    const threads = await testDb.query.messageThreads.findMany({
      where: eq(messageThreads.projectId, projectId),
    });
    expect(threads).toHaveLength(1);
    // One thread AND both messages: a thread count of 1 alone would also be
    // satisfied by one of the two posts being silently lost.
    expect(
      await testDb.query.messages.findMany({ where: eq(messages.threadId, threads[0]!.id) }),
    ).toHaveLength(2);
  });

  it('separates corporations on the same project (US-5.4)', async () => {
    const { admin, charity, projectId } = await charityWithProject('multi');
    const one = await corporation('one', admin);
    const two = await corporation('two', admin);
    await expressInterest(one.userId, projectId, one.organisationId, testDb);
    await expressInterest(two.userId, projectId, two.organisationId, testDb);

    const a = await postMessage(
      one.userId,
      projectId,
      { corporationOrgId: one.organisationId, body: 'Our commercial terms.' },
      testDb,
    );
    const b = await postMessage(
      two.userId,
      projectId,
      { corporationOrgId: two.organisationId, body: 'Our different terms.' },
      testDb,
    );
    expect(a.threadId).not.toBe(b.threadId);

    // Neither corporation can read the other's thread…
    await expect(getThread(one.userId, b.threadId, {}, testDb)).rejects.toBeInstanceOf(
      NotFoundError,
    );
    // …and the charity, who is party to both, sees each separately.
    const viewA = await getThread(charity.userId, a.threadId, {}, testDb);
    const viewB = await getThread(charity.userId, b.threadId, {}, testDb);
    expect(viewA.messages.map((m) => m.body)).toEqual(['Our commercial terms.']);
    expect(viewB.messages.map((m) => m.body)).toEqual(['Our different terms.']);
  });
});

describe('Messaging — who may read (US-8.3)', () => {
  it('is invisible to outsiders and to a platform admin, with the same 404', async () => {
    const { admin, charity, projectId } = await charityWithProject('priv');
    const corp = await corporation('priv', admin);
    await expressInterest(corp.userId, projectId, corp.organisationId, testDb);
    const { threadId } = await postMessage(
      corp.userId,
      projectId,
      { corporationOrgId: corp.organisationId, body: 'Commercially sensitive.' },
      testDb,
    );

    // A platform admin has no membership in either organisation, so the same
    // check that stops a stranger stops them. Asserting the exact message
    // matters: the US-6.3 drive found this test passing because a DOWNSTREAM
    // read threw its own NotFoundError, not the participation check.
    await expect(getThread(admin, threadId, {}, testDb)).rejects.toThrow('Conversation not found.');

    const otherCharity = await registerCharity(
      {
        email: 'rival@other.org',
        password: 'a-strong-password',
        charityName: 'Other Cause',
        regNumber: 'CH-OTHER',
      },
      testDb,
    );
    await expect(getThread(otherCharity.userId, threadId, {}, testDb)).rejects.toThrow(
      'Conversation not found.',
    );

    // A volunteer inside the delivering corporation is still not a party.
    const { userId: volunteerId } = await inviteMember(
      corp.userId,
      corp.organisationId,
      'dana@acme-priv.com',
      'volunteer',
      testDb,
    );
    await expect(getThread(volunteerId, threadId, {}, testDb)).rejects.toThrow(
      'Conversation not found.',
    );

    // Both actual parties can read it.
    expect((await getThread(charity.userId, threadId, {}, testDb)).messages).toHaveLength(1);
    expect((await getThread(corp.userId, threadId, {}, testDb)).messages).toHaveLength(1);
  });

  it('attributes each message to its author and organisation', async () => {
    const { admin, charity, projectId } = await charityWithProject('attr');
    const corp = await corporation('attr', admin);
    await expressInterest(corp.userId, projectId, corp.organisationId, testDb);
    const { threadId } = await postMessage(
      corp.userId,
      projectId,
      { corporationOrgId: corp.organisationId, body: 'From the corporation.' },
      testDb,
    );
    await postMessage(
      charity.userId,
      projectId,
      { corporationOrgId: corp.organisationId, body: 'From the charity.' },
      testDb,
    );

    const asCharity = await getThread(charity.userId, threadId, {}, testDb);
    expect(asCharity.messages.map((m) => m.authorOrgName)).toEqual([
      'Acme attr Ltd',
      'Good Cause attr',
    ]);
    expect(asCharity.messages.map((m) => m.authorLabel)).toEqual([
      'carlos-attr@acme-attr.com',
      'petra-attr@goodcause.org',
    ]);
    // "Mine" is per-viewer, so the same rows read differently on each side.
    expect(asCharity.messages.map((m) => m.isMySide)).toEqual([false, true]);
    const asCorp = await getThread(corp.userId, threadId, {}, testDb);
    expect(asCorp.messages.map((m) => m.isMySide)).toEqual([true, false]);
  });

  it('lists no conversations for someone who is not a party', async () => {
    const { admin, projectId } = await charityWithProject('none');
    const corp = await corporation('none', admin);
    await expressInterest(corp.userId, projectId, corp.organisationId, testDb);
    // Returns [] rather than throwing, so any page can call it.
    expect(await listConversationsForProject(admin, projectId, testDb)).toEqual([]);
  });
});

describe('Messaging — ordering and paging (US-8.3)', () => {
  it('orders oldest-first even when timestamps are identical', async () => {
    const { admin, charity, projectId } = await charityWithProject('order');
    const corp = await corporation('order', admin);
    await expressInterest(corp.userId, projectId, corp.organisationId, testDb);
    const { threadId } = await postMessage(
      corp.userId,
      projectId,
      { corporationOrgId: corp.organisationId, body: 'm0' },
      testDb,
    );

    // Written inside ONE transaction, so created_at is byte-identical for all
    // of them: a test with sleeps between posts would pass on created_at alone
    // and prove nothing about `seq`.
    await testDb.transaction(async (tx) => {
      const [t] = await tx.query.messageThreads.findMany({
        where: eq(messageThreads.id, threadId),
      });
      for (const n of [1, 2, 3, 4]) {
        await tx.insert(messages).values({
          threadId: t!.id,
          authorUserId: charity.userId,
          authorOrgId: (await tx.query.messageThreads.findFirst({
            where: eq(messageThreads.id, threadId),
          }))!.corporationOrgId,
          body: `m${n}`,
        });
      }
    });

    const view = await getThread(charity.userId, threadId, {}, testDb);
    expect(view.messages.map((m) => m.body)).toEqual(['m0', 'm1', 'm2', 'm3', 'm4']);
    const stamps = new Set(view.messages.slice(1).map((m) => m.postedAt.toISOString()));
    expect(stamps.size).toBe(1); // proves the ordering was not doing it by time
  });

  it('opens on the NEWEST page and walks backwards', async () => {
    const { admin, charity, projectId } = await charityWithProject('page');
    const corp = await corporation('page', admin);
    await expressInterest(corp.userId, projectId, corp.organisationId, testDb);
    const { threadId } = await postMessage(
      corp.userId,
      projectId,
      { corporationOrgId: corp.organisationId, body: 'm0' },
      testDb,
    );
    const thread = (await testDb.query.messageThreads.findFirst({
      where: eq(messageThreads.id, threadId),
    }))!;
    for (let n = 1; n <= 7; n++) {
      await testDb.insert(messages).values({
        threadId: thread.id,
        authorUserId: charity.userId,
        authorOrgId: thread.corporationOrgId,
        body: `m${n}`,
      });
    }

    // A naive ORDER BY seq ASC LIMIT n also satisfies "oldest-first" and would
    // return m0..m2 here — opening a long thread on its very first message.
    const firstPage = await getThread(charity.userId, threadId, { limit: 3 }, testDb);
    expect(firstPage.messages.map((m) => m.body)).toEqual(['m5', 'm6', 'm7']);
    expect(firstPage.hasMore).toBe(true);

    const older = await getThread(
      charity.userId,
      threadId,
      { limit: 3, before: firstPage.nextBefore! },
      testDb,
    );
    expect(older.messages.map((m) => m.body)).toEqual(['m2', 'm3', 'm4']);
    expect(older.hasMore).toBe(true);

    const oldest = await getThread(
      charity.userId,
      threadId,
      { limit: 3, before: older.nextBefore! },
      testDb,
    );
    expect(oldest.messages.map((m) => m.body)).toEqual(['m0', 'm1']);
    expect(oldest.hasMore).toBe(false);
    expect(oldest.nextBefore).toBeNull();
  });
});

describe('Messaging — erasure (US-2.5 x US-8.3)', () => {
  it('redacts the words but keeps the other side’s record of the exchange', async () => {
    const { admin, charity, projectId } = await charityWithProject('erase');
    const corp = await corporation('erase', admin);
    await expressInterest(corp.userId, projectId, corp.organisationId, testDb);
    const { threadId } = await postMessage(
      corp.userId,
      projectId,
      { corporationOrgId: corp.organisationId, body: 'Please forget I said this.' },
      testDb,
    );
    await postMessage(
      charity.userId,
      projectId,
      { corporationOrgId: corp.organisationId, body: 'The charity said this.' },
      testDb,
    );

    await eraseUser(corp.userId, testDb);

    // The charity keeps its half of a two-party negotiation; the erased
    // person's words are gone, tombstoned on a column rather than a magic body.
    const view = await getThread(charity.userId, threadId, {}, testDb);
    expect(view.messages).toHaveLength(2);
    expect(view.messages[0]).toMatchObject({ redacted: true, body: '' });
    expect(view.messages[1]).toMatchObject({ redacted: false, body: 'The charity said this.' });
    const stored = await testDb.query.messages.findMany({ where: eq(messages.threadId, threadId) });
    expect(stored.find((m) => m.redactedAt !== null)?.body).toBe('');
  });
});

describe('Messaging — participation edge cases (US-8.3)', () => {
  it('does not lock out a CSR manager who also volunteers for the charity', async () => {
    // Holding a row in BOTH organisations is ordinary — a CSR manager can
    // volunteer at the weekend. Resolving only one membership dropped them
    // through both branches into a 404 on their own conversation, while the
    // project page kept offering them the link.
    const { admin, charity, projectId } = await charityWithProject('dual');
    const corp = await corporation('dual', admin);
    await expressInterest(corp.userId, projectId, corp.organisationId, testDb);
    const { threadId } = await postMessage(
      corp.userId,
      projectId,
      { corporationOrgId: corp.organisationId, body: 'Before I also volunteered.' },
      testDb,
    );

    await inviteMember(
      charity.userId,
      charity.organisationId,
      'carlos-dual@acme-dual.com',
      'volunteer',
      testDb,
    );

    // Still their conversation, still postable.
    const view = await getThread(corp.userId, threadId, {}, testDb);
    expect(view.messages).toHaveLength(1);
    expect(view.viewer.side).toBe('corporation');
    await expect(
      postMessage(
        corp.userId,
        projectId,
        { corporationOrgId: corp.organisationId, body: 'And after.' },
        testDb,
      ),
    ).resolves.toBeTruthy();
    // And the list agrees with the thread read, rather than offering a 404.
    const list = await listConversationsForProject(corp.userId, projectId, testDb);
    expect(list).toHaveLength(1);
  });

  it('shuts out a manager of the owning charity', async () => {
    // Narrow roles: only the charity OWNER, not any charity staffer.
    const { admin, charity, projectId } = await charityWithProject('mgr');
    const corp = await corporation('mgr', admin);
    await expressInterest(corp.userId, projectId, corp.organisationId, testDb);
    const { threadId } = await postMessage(
      corp.userId,
      projectId,
      { corporationOrgId: corp.organisationId, body: 'Commercially sensitive.' },
      testDb,
    );
    const manager = await inviteMember(
      charity.userId,
      charity.organisationId,
      'mgr@goodcause.org',
      'manager',
      testDb,
    );
    await expect(getThread(manager.userId, threadId, {}, testDb)).rejects.toThrow(
      'Conversation not found.',
    );
  });

  it('hides a draft project from a corporation entirely, not "no relationship"', async () => {
    // A 403 would confirm that a draft project id exists to someone who can
    // never see the project.
    const { admin, charity } = await charityWithProject('draft');
    const draft = await createDraftProject(
      charity.userId,
      {
        charityOrgId: charity.organisationId,
        title: 'Still a draft',
        description: 'A worthy community cause that needs a hand from local people.',
        goal: 'Not published yet.',
        category: 'software',
      },
      testDb,
    );
    const corp = await corporation('draft', admin);
    await expect(
      postMessage(
        corp.userId,
        draft.projectId,
        { corporationOrgId: corp.organisationId, body: 'I can see your draft.' },
        testDb,
      ),
    ).rejects.toThrow('Conversation not found.');
  });

  it('tells the truth about whether posting is possible', async () => {
    // Posting needs the CORPORATION verified whichever side writes, so the
    // charity must not be offered a composer that then refuses it.
    const { admin, charity, projectId } = await charityWithProject('cp');
    const corp = await corporation('cp', admin, false);
    await expressInterest(corp.userId, projectId, corp.organisationId, testDb);

    const list = await listConversationsForProject(charity.userId, projectId, testDb);
    expect(list).toHaveLength(1);
    expect(list[0]!.canPost).toBe(false);
    await expect(
      postMessage(
        charity.userId,
        projectId,
        { corporationOrgId: corp.organisationId, body: 'Welcome aboard.' },
        testDb,
      ),
    ).rejects.toBeInstanceOf(NotVerifiedError);

    // Once verified, both the flag and the action agree.
    await approveVerification(corp.verificationRequestId, admin, testDb);
    const after = await listConversationsForProject(charity.userId, projectId, testDb);
    expect(after[0]!.canPost).toBe(true);
    const { threadId } = await postMessage(
      charity.userId,
      projectId,
      { corporationOrgId: corp.organisationId, body: 'Welcome aboard.' },
      testDb,
    );
    expect((await getThread(charity.userId, threadId, {}, testDb)).viewer).toMatchObject({
      canPost: true,
      cannotPostReason: null,
    });
  });

  it('rejects a cursor that is not a whole, non-negative number', async () => {
    const { admin, projectId } = await charityWithProject('cur');
    const corp = await corporation('cur', admin);
    await expressInterest(corp.userId, projectId, corp.organisationId, testDb);
    const { threadId } = await postMessage(
      corp.userId,
      projectId,
      { corporationOrgId: corp.organisationId, body: 'One message.' },
      testDb,
    );
    // `seq` is a bigint; a fractional or absurd value reaches Postgres as
    // invalid text and used to surface as a 500.
    for (const before of [1.5, Number.NaN, 1e30, -1]) {
      await expect(getThread(corp.userId, threadId, { before }, testDb)).rejects.toBeInstanceOf(
        InvalidCursorError,
      );
    }
    // A legitimate cursor still works.
    await expect(getThread(corp.userId, threadId, { before: 0 }, testDb)).resolves.toMatchObject({
      messages: [],
    });
  });
});
