import { describe, it, expect } from 'vitest';
import { and, eq } from 'drizzle-orm';
import { testDb } from '@/test/db';
import { agentDeliveryRuns, runMilestones, deployedEnvironments } from '@/db/schema';
import { FakeModelProvider } from '@/lib/fake-model-provider';
import { FakeSandboxRunner } from '@/lib/fake-sandbox-runner';
import { FakeDeployer } from '@/lib/fake-deployer';
import { fundComputeBudget, acceptComputePledge } from '@/modules/commitments';
import {
  registerCharity,
  registerCorporation,
  approveVerification,
  createPlatformAdmin,
} from '@/modules/identity';
import { createDraftProject, setResourceNeeds, publishProject } from '@/modules/projects';
import { runCurrentPhase, approveMilestone, requestChanges } from './orchestrator';
import { runDeliveryPhase } from './delivery';

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

describe('agent-delivery delivery phase', () => {
  it('deploys to a staging URL, records it, and opens the delivery gate', async () => {
    const { runId } = await runToDelivery();
    const deployer = new FakeDeployer();
    const r = await runDeliveryPhase(runId, deployer, testDb);
    expect(r.status).toBe('awaiting_review');
    expect(deployer.calls[0]!.environment).toBe('staging');
    const env = await testDb.query.deployedEnvironments.findFirst({
      where: eq(deployedEnvironments.runId, runId),
    });
    expect(env!.environment).toBe('staging');
    expect(env!.status).toBe('live');
    expect(env!.url).toContain(runId);
    const run = await testDb.query.agentDeliveryRuns.findFirst({
      where: eq(agentDeliveryRuns.id, runId),
    });
    expect(run!.status).toBe('awaiting_gate');
    const ms = await testDb.query.runMilestones.findFirst({
      where: and(eq(runMilestones.runId, runId), eq(runMilestones.phase, 'delivery')),
    });
    expect(ms!.status).toBe('awaiting_review');
  });

  it('supersedes the prior live deployment on a re-deploy after changes requested', async () => {
    const { charity, runId } = await runToDelivery();
    const deployer = new FakeDeployer();
    const first = await runDeliveryPhase(runId, deployer, testDb);
    await requestChanges(charity.userId, first.milestoneId, 'Please fix the header', testDb);

    await runDeliveryPhase(runId, deployer, testDb);

    const live = await testDb.query.deployedEnvironments.findMany({
      where: and(eq(deployedEnvironments.runId, runId), eq(deployedEnvironments.status, 'live')),
    });
    expect(live).toHaveLength(1);
    const tornDown = await testDb.query.deployedEnvironments.findMany({
      where: and(
        eq(deployedEnvironments.runId, runId),
        eq(deployedEnvironments.status, 'torn_down'),
      ),
    });
    expect(tornDown).toHaveLength(1);
  });
});
