import { describe, it, expect } from 'vitest';
import { eq } from 'drizzle-orm';
import { testDb } from '@/test/db';
import { agentDeliveryRuns, runMilestones } from '@/db/schema';
import { FakeModelProvider } from '@/lib/fake-model-provider';
import { fundComputeBudget, acceptComputePledge } from '@/modules/commitments';
import {
  registerCharity,
  registerCorporation,
  approveVerification,
  createPlatformAdmin,
} from '@/modules/identity';
import { createDraftProject, setResourceNeeds, publishProject } from '@/modules/projects';
import { advanceRun } from './dispatcher';
import { approveMilestone, requestChanges } from './orchestrator';

async function authorisedRun(budgetMinor: number) {
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
    { corporationOrgId: corp.organisationId, templateCode: 'static-site', budgetMinor },
    testDb,
  );
  const { runId } = await acceptComputePledge(charity.userId, computePledgeId, testDb);
  return { charity, runId };
}

describe('agent-delivery dispatcher (advanceRun)', () => {
  it('drives requirements → gate → design → gate across approvals', async () => {
    const { charity, runId } = await authorisedRun(20000);
    const provider = new FakeModelProvider([{ text: 'criteria' }, { text: 'design doc' }]);

    const a1 = await advanceRun(runId, provider, testDb);
    expect(a1.ran).toBe(true);
    let run = await testDb.query.agentDeliveryRuns.findFirst({
      where: eq(agentDeliveryRuns.id, runId),
    });
    expect(run!.status).toBe('awaiting_gate');
    expect(run!.currentPhase).toBe('requirements');

    // human approves requirements → run authorized on design
    const reqMilestone = await testDb.query.runMilestones.findFirst({
      where: eq(runMilestones.runId, runId),
    });
    await approveMilestone(charity.userId, reqMilestone!.id, testDb);

    const a2 = await advanceRun(runId, provider, testDb);
    expect(a2.ran).toBe(true);
    run = await testDb.query.agentDeliveryRuns.findFirst({
      where: eq(agentDeliveryRuns.id, runId),
    });
    expect(run!.status).toBe('awaiting_gate');
    expect(run!.currentPhase).toBe('design');
    expect(provider.calls).toHaveLength(2);
  });

  it('no-ops on a run awaiting a human gate', async () => {
    const { runId } = await authorisedRun(20000);
    const provider = new FakeModelProvider([{ text: 'criteria' }, { text: 'second' }]);
    await advanceRun(runId, provider, testDb); // runs requirements → awaiting_gate
    const a = await advanceRun(runId, provider, testDb); // must NOT run again while awaiting gate
    expect(a.ran).toBe(false);
    expect(provider.calls).toHaveLength(1);
  });

  it('re-runs the current phase after changes are requested', async () => {
    const { charity, runId } = await authorisedRun(20000);
    const provider = new FakeModelProvider([{ text: 'draft one' }, { text: 'draft two' }]);
    await advanceRun(runId, provider, testDb);
    const ms = await testDb.query.runMilestones.findFirst({
      where: eq(runMilestones.runId, runId),
    });
    await requestChanges(charity.userId, ms!.id, 'Add an accessibility criterion', testDb);
    const a = await advanceRun(runId, provider, testDb); // run is 'running' → re-run requirements
    expect(a.ran).toBe(true);
    expect(provider.calls).toHaveLength(2);
    const run = await testDb.query.agentDeliveryRuns.findFirst({
      where: eq(agentDeliveryRuns.id, runId),
    });
    expect(run!.status).toBe('awaiting_gate');
  });
});
