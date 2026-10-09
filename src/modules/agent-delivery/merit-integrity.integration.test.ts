import { describe, it, expect } from 'vitest';
import { eq } from 'drizzle-orm';
import { testDb } from '@/test/db';
import { projectScores, engagementEvents, agentDeliveryRuns } from '@/db/schema';
import { FakeModelProvider } from '@/lib/fake-model-provider';
import { fundComputeBudget, acceptComputePledge } from '@/modules/commitments';
import {
  registerCharity,
  registerCorporation,
  approveVerification,
  createPlatformAdmin,
} from '@/modules/identity';
import { createDraftProject, setResourceNeeds, publishProject } from '@/modules/projects';
import { runRequirementsPhase, approveMilestone, setRunStatus } from '.';

async function fixture(budgetMinor: number) {
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
  return { admin, charity, project, runId };
}

describe('agent-delivery merit integrity + kill switch', () => {
  it('a full agent run changes zero score/engagement rows for the project', async () => {
    const { charity, project, runId } = await fixture(5000);
    const res = await runRequirementsPhase(
      runId,
      new FakeModelProvider([{ text: 'criteria' }]),
      testDb,
    );
    await approveMilestone(charity.userId, res.milestoneId, testDb);

    const scores = await testDb
      .select()
      .from(projectScores)
      .where(eq(projectScores.projectId, project.projectId));
    const events = await testDb
      .select()
      .from(engagementEvents)
      .where(eq(engagementEvents.projectId, project.projectId));
    expect(scores).toHaveLength(0); // agent activity never wrote a score
    expect(events).toHaveLength(0);
  });

  it('an admin kill switch halts a run', async () => {
    const { admin, runId } = await fixture(5000);
    await setRunStatus(admin, runId, 'halted', testDb);
    const run = await testDb.query.agentDeliveryRuns.findFirst({
      where: eq(agentDeliveryRuns.id, runId),
    });
    expect(run!.status).toBe('halted');
    // a halted run refuses to execute a phase (no model call)
    const provider = new FakeModelProvider([{ text: 'x' }]);
    const res = await runRequirementsPhase(runId, provider, testDb);
    expect(res.status).toBe('halted');
    expect(provider.calls).toHaveLength(0);
  });
});
