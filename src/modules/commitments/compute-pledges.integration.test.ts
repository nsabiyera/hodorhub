import { describe, it, expect } from 'vitest';
import { eq } from 'drizzle-orm';
import { testDb } from '@/test/db';
import { computePledges, agentDeliveryRuns, runBudgets, outbox } from '@/db/schema';
import {
  registerCharity,
  registerCorporation,
  approveVerification,
  createPlatformAdmin,
  NotFoundError,
  InvalidStateError,
} from '@/modules/identity';
import { createDraftProject, setResourceNeeds, publishProject } from '@/modules/projects';
import {
  fundComputeBudget,
  acceptComputePledge,
  listComputePledgesForProject,
  listComputePledgesForCorp,
  declineComputePledge,
} from './service';

async function scenario() {
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
  const corp = await registerCorporation(
    {
      email: 'carlos@acme.com',
      password: 'a-strong-password',
      companyName: 'Acme',
      emailDomain: 'acme.com',
    },
    testDb,
  );
  await approveVerification(charity.verificationRequestId, admin, testDb);
  await approveVerification(corp.verificationRequestId, admin, testDb);
  const project = await createDraftProject(
    charity.userId,
    {
      charityOrgId: charity.organisationId,
      title: 'Portal',
      description: 'A worthy cause that needs a hand.',
      goal: 'Reach the finish line.',
      category: 'software',
    },
    testDb,
  );
  await setResourceNeeds(
    charity.userId,
    project.projectId,
    [
      {
        skill: 'Backend',
        role: 'Dev',
        kind: 'ongoing',
        quantity: 1,
        hoursPerWeek: 2,
        durationWeeks: 8,
      },
    ],
    testDb,
  );
  await publishProject(charity.userId, project.projectId, testDb);
  return { charity, corp, project };
}

describe('compute pledges (Epic 11 trigger)', () => {
  it('funds a budget then authorises a run + escrows it on acceptance', async () => {
    const { charity, corp, project } = await scenario();
    const { computePledgeId } = await fundComputeBudget(
      corp.userId,
      project.projectId,
      { corporationOrgId: corp.organisationId, templateCode: 'static-site', budgetMinor: 5000 },
      testDb,
    );
    const { runId } = await acceptComputePledge(charity.userId, computePledgeId, testDb);

    const pledge = await testDb.query.computePledges.findFirst({
      where: eq(computePledges.id, computePledgeId),
    });
    expect(pledge!.status).toBe('accepted');
    const run = await testDb.query.agentDeliveryRuns.findFirst({
      where: eq(agentDeliveryRuns.id, runId),
    });
    expect(run!.status).toBe('authorized');
    const budget = await testDb.query.runBudgets.findFirst({ where: eq(runBudgets.runId, runId) });
    expect(budget!.committedMinor).toBe(5000);
    const events = await testDb
      .select()
      .from(outbox)
      .where(eq(outbox.eventType, 'ComputePledgeAccepted'));
    expect(events).toHaveLength(1);
  });

  it('a different charity cannot accept the pledge', async () => {
    const { corp, project } = await scenario();
    const other = await registerCharity(
      {
        email: 'x@other.org',
        password: 'a-strong-password',
        charityName: 'Other',
        regNumber: 'CH-2',
      },
      testDb,
    );
    const { computePledgeId } = await fundComputeBudget(
      corp.userId,
      project.projectId,
      { corporationOrgId: corp.organisationId, templateCode: 'static-site', budgetMinor: 5000 },
      testDb,
    );
    await expect(acceptComputePledge(other.userId, computePledgeId, testDb)).rejects.toBeInstanceOf(
      NotFoundError,
    );
  });

  describe('listComputePledgesForProject / listComputePledgesForCorp / declineComputePledge', () => {
    it('lists for the owning charity, denies a non-owning charity, lists for the corp, and declines from proposed', async () => {
      const { charity, corp, project } = await scenario();
      const { computePledgeId } = await fundComputeBudget(
        corp.userId,
        project.projectId,
        { corporationOrgId: corp.organisationId, templateCode: 'static-site', budgetMinor: 5000 },
        testDb,
      );

      const forCharity = await listComputePledgesForProject(
        charity.userId,
        project.projectId,
        testDb,
      );
      expect(forCharity).toHaveLength(1);
      expect(forCharity[0]!.status).toBe('proposed');

      const other = await registerCharity(
        {
          email: 'y@other.org',
          password: 'a-strong-password',
          charityName: 'Other Cause',
          regNumber: 'CH-3',
        },
        testDb,
      );
      await expect(
        listComputePledgesForProject(other.userId, project.projectId, testDb),
      ).rejects.toBeInstanceOf(NotFoundError);

      const forCorp = await listComputePledgesForCorp(
        corp.userId,
        project.projectId,
        corp.organisationId,
        testDb,
      );
      expect(forCorp).toHaveLength(1);
      expect(forCorp[0]!.id).toBe(computePledgeId);

      await declineComputePledge(charity.userId, computePledgeId, undefined, testDb);
      const declined = await testDb.query.computePledges.findFirst({
        where: eq(computePledges.id, computePledgeId),
      });
      expect(declined!.status).toBe('declined');
      const events = await testDb
        .select()
        .from(outbox)
        .where(eq(outbox.eventType, 'ComputePledgeDeclined'));
      expect(events).toHaveLength(1);

      await expect(
        declineComputePledge(charity.userId, computePledgeId, undefined, testDb),
      ).rejects.toBeInstanceOf(InvalidStateError);
    });
  });
});
