import { testDb } from './db';
import { FakeModelProvider } from '@/lib/fake-model-provider';
import { FakeSandboxRunner } from '@/lib/fake-sandbox-runner';
import { FakeDeployer } from '@/lib/fake-deployer';
import { runCurrentPhase } from '@/modules/agent-delivery/orchestrator';
import { runDeliveryPhase } from '@/modules/agent-delivery/delivery';
import { approveMilestone } from '@/modules/agent-delivery/service';
import { fundComputeBudget, acceptComputePledge } from '@/modules/commitments';
import {
  registerCharity,
  registerCorporation,
  approveVerification,
  createPlatformAdmin,
} from '@/modules/identity';
import { createDraftProject, setResourceNeeds, publishProject } from '@/modules/projects';

/**
 * Shared agent-delivery integration fixtures (US-11.5). Several suites need the
 * same "two verified orgs" and "one authorised run" starting points; keeping
 * them here avoids a copy of this setup in every test file.
 */
export async function twoOrgs() {
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
  return { admin, charity, corp };
}

/** Two verified orgs → published project → funded pledge → accepted = one authorised run. */
export async function authorisedRun() {
  const { admin, charity, corp } = await twoOrgs();
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
  return { admin, charity, corp, projectId: project.projectId, runId };
}

/**
 * An "approved app on staging" (US-11.8): a run driven through all four phases
 * with every milestone approved, so the delivery milestone is `approved`, one
 * staging environment is `live`, and the run is `completed` — the exact state a
 * production promotion may be requested from.
 *
 * Returns the FakeDeployer too, so a caller can assert what was deployed and
 * with which environment.
 */
export async function promotableRun() {
  const base = await authorisedRun();
  const { charity, runId } = base;
  const provider = new FakeModelProvider([
    { text: 'criteria' },
    { text: 'design' },
    { text: 'code' },
  ]);
  const sandbox = new FakeSandboxRunner();
  const deployer = new FakeDeployer();

  const requirements = await runCurrentPhase(runId, provider, testDb);
  await approveMilestone(charity.userId, requirements.milestoneId, testDb);
  const design = await runCurrentPhase(runId, provider, testDb);
  await approveMilestone(charity.userId, design.milestoneId, testDb);
  const build = await runCurrentPhase(runId, provider, testDb, { sandbox });
  await approveMilestone(charity.userId, build.milestoneId, testDb);
  const delivery = await runDeliveryPhase(runId, deployer, testDb);
  await approveMilestone(charity.userId, delivery.milestoneId, testDb);

  return { ...base, deployer };
}
