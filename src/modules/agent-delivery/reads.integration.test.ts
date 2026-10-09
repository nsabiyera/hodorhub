import { describe, it, expect } from 'vitest';
import { testDb } from '@/test/db';
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
import { runCurrentPhase, approveMilestone } from './orchestrator';
import { runDeliveryPhase } from './delivery';
import { getRunForProject } from './reads';

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
  return { charity, projectId: project.projectId, runId };
}

describe('agent-delivery reads — getRunForProject', () => {
  it('returns null when the project has no run', async () => {
    const result = await getRunForProject('00000000-0000-0000-0000-000000000000', testDb);
    expect(result).toBeNull();
  });

  it('returns run/milestones/budget/staging/production at the requirements gate', async () => {
    const { projectId, runId } = await authorisedRun(5000);
    const provider = new FakeModelProvider([
      { text: 'GIVEN a visitor WHEN they open the site THEN they see the mission' },
    ]);
    const res = await runCurrentPhase(runId, provider, testDb);
    expect(res.status).toBe('awaiting_review');

    const result = await getRunForProject(projectId, testDb);
    expect(result).not.toBeNull();
    expect(result!.run.id).toBe(runId);
    expect(result!.run.currentPhase).toBe('requirements');
    expect(result!.milestones).toHaveLength(1);
    expect(result!.milestones[0]!.phase).toBe('requirements');
    expect(result!.milestones[0]!.status).toBe('awaiting_review');
    expect(result!.budget.committedMinor).toBe(5000);
    expect(result!.staging).toBeNull();
    expect(result!.production).toBeNull();
  });

  it('returns the deployed environment once delivery has deployed to staging', async () => {
    const { charity, projectId, runId } = await authorisedRun(50000);
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

    const deployer = new FakeDeployer();
    await runDeliveryPhase(runId, deployer, testDb);

    const result = await getRunForProject(projectId, testDb);
    expect(result!.staging).not.toBeNull();
    expect(result!.staging!.status).toBe('live');
    expect(result!.staging!.url).toContain('preview.hodorhub.app');
    expect(result!.production).toBeNull();
    // requirements, design, build, delivery — phase-ordered
    expect(result!.milestones.map((m) => m.phase)).toEqual([
      'requirements',
      'design',
      'build',
      'delivery',
    ]);
  });
});
