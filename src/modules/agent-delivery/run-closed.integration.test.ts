import { describe, it, expect } from 'vitest';
import { and, eq } from 'drizzle-orm';
import { testDb } from '@/test/db';
import { outbox } from '@/db/schema';
import { FakeModelProvider } from '@/lib/fake-model-provider';
import { FakeSandboxRunner } from '@/lib/fake-sandbox-runner';
import { FakeDeployer } from '@/lib/fake-deployer';
import { fundComputeBudget, acceptComputePledge } from '@/modules/commitments';
import {
  registerCharity,
  registerCorporation,
  approveVerification,
  createPlatformAdmin,
  InvalidStateError,
} from '@/modules/identity';
import { createDraftProject, setResourceNeeds, publishProject } from '@/modules/projects';
import { runCurrentPhase, approveMilestone, rejectMilestone } from './orchestrator';
import { runDeliveryPhase } from './delivery';
import { setRunStatus } from './service';

async function runToDelivery() {
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
  const { computePledgeId } = await fundComputeBudget(
    corp.userId,
    project.projectId,
    { corporationOrgId: corp.organisationId, templateCode: 'static-site', budgetMinor: 50000 },
    testDb,
  );
  const { runId } = await acceptComputePledge(charity.userId, computePledgeId, testDb);
  const provider = new FakeModelProvider([
    { text: 'criteria' },
    { text: 'design' },
    { text: 'code' },
  ]);
  const sandbox = new FakeSandboxRunner();
  const a = await runCurrentPhase(runId, provider, testDb);
  await approveMilestone(charity.userId, a.milestoneId, testDb);
  const b = await runCurrentPhase(runId, provider, testDb);
  await approveMilestone(charity.userId, b.milestoneId, testDb);
  const c = await runCurrentPhase(runId, provider, testDb, { sandbox });
  await approveMilestone(charity.userId, c.milestoneId, testDb);
  return { charity, runId };
}

describe('agent-delivery RunClosed terminal event', () => {
  it('emits RunClosed with outcome completed when the run completes on final approval', async () => {
    const { charity, runId } = await runToDelivery();
    const deployer = new FakeDeployer();
    const r = await runDeliveryPhase(runId, deployer, testDb);
    await approveMilestone(charity.userId, r.milestoneId, testDb);

    const events = await testDb.select().from(outbox).where(eq(outbox.eventType, 'RunClosed'));
    expect(events).toHaveLength(1);
    const payload = events[0]!.payload as Record<string, unknown>;
    expect(payload.runId).toBe(runId);
    expect(payload.outcome).toBe('completed');
    expect(typeof payload.committedMinor).toBe('number');
    expect(typeof payload.consumedMinor).toBe('number');
    expect(payload.currency).toBe('GBP');
    expect(typeof payload.priceBookVersion).toBe('string');
    expect(typeof payload.computePledgeId).toBe('string');
    expect(typeof payload.corporationOrgId).toBe('string');
  });

  it('emits RunClosed with outcome failed when a milestone is rejected', async () => {
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
    const { computePledgeId } = await fundComputeBudget(
      corp.userId,
      project.projectId,
      { corporationOrgId: corp.organisationId, templateCode: 'static-site', budgetMinor: 50000 },
      testDb,
    );
    const { runId } = await acceptComputePledge(charity.userId, computePledgeId, testDb);
    const provider = new FakeModelProvider([{ text: 'criteria' }]);
    const r = await runCurrentPhase(runId, provider, testDb);
    await rejectMilestone(charity.userId, r.milestoneId, 'Not what we asked for', testDb);

    const events = await testDb
      .select()
      .from(outbox)
      .where(and(eq(outbox.eventType, 'RunClosed')));
    expect(events).toHaveLength(1);
    const payload = events[0]!.payload as Record<string, unknown>;
    expect(payload.runId).toBe(runId);
    expect(payload.outcome).toBe('failed');
  });

  it('rejects setRunStatus on a completed run and does not duplicate RunClosed', async () => {
    const { charity, runId } = await runToDelivery();
    const admin = await createPlatformAdmin('admin2@hh.com', 'admin-password-1', testDb);
    const deployer = new FakeDeployer();
    const r = await runDeliveryPhase(runId, deployer, testDb);
    await approveMilestone(charity.userId, r.milestoneId, testDb);

    await expect(setRunStatus(admin, runId, 'halted', testDb)).rejects.toBeInstanceOf(
      InvalidStateError,
    );

    const events = await testDb.select().from(outbox).where(eq(outbox.eventType, 'RunClosed'));
    expect(events).toHaveLength(1);
    const payload = events[0]!.payload as Record<string, unknown>;
    expect(payload.runId).toBe(runId);
    expect(payload.outcome).toBe('completed');
  });
});
