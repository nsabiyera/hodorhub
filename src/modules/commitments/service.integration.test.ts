import { describe, it, expect } from 'vitest';
import { eq } from 'drizzle-orm';
import { testDb } from '@/test/db';
import { relayOutbox } from '@/modules/notifications';
import { projects, pledges, deliveryWorkspaces, notifications } from '@/db/schema';
import {
  registerCharity,
  registerCorporation,
  approveVerification,
  createPlatformAdmin,
  ForbiddenError,
  NotFoundError,
  InvalidStateError,
} from '@/modules/identity';
import {
  createDraftProject,
  setResourceNeeds,
  publishProject,
  transitionProjectStatus,
} from '@/modules/projects';
import {
  expressInterest,
  pledgeResources,
  listPledgesForProject,
  acceptPledge,
  declinePledge,
} from './service';

const need = {
  skill: 'Backend development',
  role: 'Backend developer',
  kind: 'ongoing' as const,
  quantity: 1,
  hoursPerWeek: 2,
  durationWeeks: 8,
};
const pledgeInput = (corporationOrgId: string) => ({
  corporationOrgId,
  resourceType: 'Backend developer time',
  quantity: 2,
  cadence: '2 hrs/week',
  durationWeeks: 8,
});

async function publishedProject() {
  const admin = await createPlatformAdmin('admin@hh.com', 'admin-password-1', testDb);
  const charity = await registerCharity(
    {
      email: 'petra@goodcause.org',
      password: 'a-strong-password',
      charityName: 'Good Cause',
      regNumber: 'CH-1',
    },
    testDb,
  );
  await approveVerification(charity.verificationRequestId, admin, testDb);
  const { projectId } = await createDraftProject(
    charity.userId,
    {
      charityOrgId: charity.organisationId,
      title: 'Rebuild the community garden',
      description: 'Rebuild the community garden for the whole neighbourhood to enjoy again.',
      goal: 'Reopen the garden by spring.',
      category: 'software',
    },
    testDb,
  );
  await setResourceNeeds(charity.userId, projectId, [need], testDb);
  await publishProject(charity.userId, projectId, testDb);
  return { charity, projectId };
}

function corporation(email = 'carlos@acme.com', domain = 'acme.com') {
  return registerCorporation(
    { email, password: 'another-strong-pw', companyName: 'Acme Ltd', emailDomain: domain },
    testDb,
  );
}

describe('Commitments — interest & pledge (US-5.1, US-5.2)', () => {
  it('a CSR manager expresses interest in a published project; charity is notified', async () => {
    const { charity, projectId } = await publishedProject();
    const corp = await corporation();
    const { interestId } = await expressInterest(
      corp.userId,
      projectId,
      corp.organisationId,
      testDb,
    );
    expect(interestId).toBeTruthy();
    await relayOutbox(testDb); // event → notification
    const notes = await testDb.query.notifications.findMany({
      where: eq(notifications.userId, charity.userId),
    });
    expect(notes.some((n) => n.type === 'interest.expressed')).toBe(true);
  });

  it('a non-CSR-manager cannot express interest / pledge', async () => {
    const { projectId } = await publishedProject();
    // A user with no membership in the corp org:
    const stranger = await createPlatformAdmin('stranger@nowhere.com', 'password-1234', testDb);
    const corp = await corporation();
    await expect(
      expressInterest(stranger, projectId, corp.organisationId, testDb),
    ).rejects.toBeInstanceOf(NotFoundError);
  });

  it('cannot pledge on a non-published project', async () => {
    const admin = await createPlatformAdmin('a@hh.com', 'admin-password-1', testDb);
    const charity = await registerCharity(
      {
        email: 'p@c.org',
        password: 'a-strong-password',
        charityName: 'Charity Two',
        regNumber: 'CH-2',
      },
      testDb,
    );
    await approveVerification(charity.verificationRequestId, admin, testDb);
    const { projectId } = await createDraftProject(
      charity.userId,
      { charityOrgId: charity.organisationId, title: 'Still a draft' },
      testDb,
    );
    const corp = await corporation();
    await expect(
      pledgeResources(corp.userId, projectId, pledgeInput(corp.organisationId), testDb),
    ).rejects.toBeInstanceOf(InvalidStateError);
  });
});

describe('Commitments — accept / decline (US-5.3)', () => {
  it('accept moves the project to in_delivery, creates a workspace, notifies the corp', async () => {
    const { charity, projectId } = await publishedProject();
    const corp = await corporation();
    const { pledgeId } = await pledgeResources(
      corp.userId,
      projectId,
      pledgeInput(corp.organisationId),
      testDb,
    );

    const { deliveryWorkspaceId } = await acceptPledge(charity.userId, pledgeId, testDb);

    const proj = await testDb.query.projects.findFirst({ where: eq(projects.id, projectId) });
    expect(proj?.status).toBe('in_delivery');
    const ws = await testDb.query.deliveryWorkspaces.findFirst({
      where: eq(deliveryWorkspaces.id, deliveryWorkspaceId),
    });
    expect(ws?.pledgeId).toBe(pledgeId);
    const p = await testDb.query.pledges.findFirst({ where: eq(pledges.id, pledgeId) });
    expect(p?.status).toBe('accepted');
    const events = (await testDb.query.outbox.findMany()).map((e) => e.eventType);
    expect(events).toContain('PledgeAccepted');
    await relayOutbox(testDb); // event → notification
    const corpUserNotes = await testDb.query.notifications.findMany({
      where: eq(notifications.userId, corp.userId),
    });
    expect(corpUserNotes.some((n) => n.type === 'pledge.accepted')).toBe(true);
  });

  it('decline records the reason and notifies the corp; project stays published', async () => {
    const { charity, projectId } = await publishedProject();
    const corp = await corporation();
    const { pledgeId } = await pledgeResources(
      corp.userId,
      projectId,
      pledgeInput(corp.organisationId),
      testDb,
    );

    await declinePledge(charity.userId, pledgeId, 'Not the right fit this quarter', testDb);
    const p = await testDb.query.pledges.findFirst({ where: eq(pledges.id, pledgeId) });
    expect(p?.status).toBe('declined');
    expect(p?.reason).toMatch(/right fit/);
    const proj = await testDb.query.projects.findFirst({ where: eq(projects.id, projectId) });
    expect(proj?.status).toBe('published'); // unchanged
  });

  it('requires a reason to decline', async () => {
    const { charity, projectId } = await publishedProject();
    const corp = await corporation();
    const { pledgeId } = await pledgeResources(
      corp.userId,
      projectId,
      pledgeInput(corp.organisationId),
      testDb,
    );
    await expect(declinePledge(charity.userId, pledgeId, '  ', testDb)).rejects.toBeInstanceOf(
      InvalidStateError,
    );
  });

  it('a different charity cannot accept/decline the pledge (NotFound, no leak)', async () => {
    const { projectId } = await publishedProject();
    const corp = await corporation();
    const { pledgeId } = await pledgeResources(
      corp.userId,
      projectId,
      pledgeInput(corp.organisationId),
      testDb,
    );
    const other = await (async () => {
      const admin = await createPlatformAdmin('a2@hh.com', 'admin-password-1', testDb);
      const c = await registerCharity(
        {
          email: 'otto@other.org',
          password: 'a-strong-password',
          charityName: 'Other',
          regNumber: 'CH-9',
        },
        testDb,
      );
      await approveVerification(c.verificationRequestId, admin, testDb);
      return c;
    })();
    await expect(acceptPledge(other.userId, pledgeId, testDb)).rejects.toBeInstanceOf(
      NotFoundError,
    );
  });

  it('cannot accept an already-decided pledge', async () => {
    const { charity, projectId } = await publishedProject();
    const corp = await corporation();
    const { pledgeId } = await pledgeResources(
      corp.userId,
      projectId,
      pledgeInput(corp.organisationId),
      testDb,
    );
    await acceptPledge(charity.userId, pledgeId, testDb);
    await expect(acceptPledge(charity.userId, pledgeId, testDb)).rejects.toBeInstanceOf(
      InvalidStateError,
    );
  });

  it('a project cannot have two accepted pledges even after reopen (M2 backstop)', async () => {
    const { charity, projectId } = await publishedProject();
    const corpA = await corporation('carlos@acme.com', 'acme.com');
    const corpB = await corporation('dana@globex.com', 'globex.com');
    const p1 = await pledgeResources(
      corpA.userId,
      projectId,
      pledgeInput(corpA.organisationId),
      testDb,
    );
    const p2 = await pledgeResources(
      corpB.userId,
      projectId,
      pledgeInput(corpB.organisationId),
      testDb,
    );

    await acceptPledge(charity.userId, p1.pledgeId, testDb); // → in_delivery
    await transitionProjectStatus(charity.userId, projectId, 'published', testDb); // reopen
    await expect(acceptPledge(charity.userId, p2.pledgeId, testDb)).rejects.toBeInstanceOf(
      InvalidStateError,
    );
  });

  it('charity_owner can list pledges on its project', async () => {
    const { charity, projectId } = await publishedProject();
    const corp = await corporation();
    await pledgeResources(corp.userId, projectId, pledgeInput(corp.organisationId), testDb);
    const list = await listPledgesForProject(charity.userId, projectId, testDb);
    expect(list).toHaveLength(1);
    // a corp user cannot list them (not charity_owner of the project org)
    await expect(listPledgesForProject(corp.userId, projectId, testDb)).rejects.toBeInstanceOf(
      NotFoundError,
    );
    expect(ForbiddenError).toBeDefined();
  });
});
