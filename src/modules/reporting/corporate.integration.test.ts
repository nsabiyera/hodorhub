import { describe, it, expect } from 'vitest';
import { testDb } from '@/test/db';
import {
  NotFoundError,
  ForbiddenError,
  inviteMember,
  registerCorporation,
} from '@/modules/identity';
import { createDraftProject, setResourceNeeds, publishProject } from '@/modules/projects';
import { pledgeResources, acceptPledge } from '@/modules/commitments';
import { allocateVolunteer, logHours, approveHours } from '@/modules/delivery';
import { completeProject } from '@/modules/projects';
import { promotableRun, twoOrgs } from '@/test/agent-delivery-fixtures';
import { entitlements } from '@/db/schema';
import { FEATURES, PlanUpgradeRequiredError } from '@/modules/monetisation';
import { getCorporateImpact } from './service';

/**
 * US-10.5 — the dashboard is a Team feature, so these tests grant the
 * entitlement explicitly. The gate itself is asserted in its own test below.
 */
async function entitleDashboard(organisationId: string) {
  await testDb.insert(entitlements).values({ organisationId, feature: FEATURES.csrDashboard });
}

const STORY = 'The site launched in March and 412 local volunteers signed up in the first month.';

const NEED = {
  skill: 'Backend',
  role: 'Dev',
  kind: 'ongoing' as const,
  quantity: 1,
  hoursPerWeek: 4,
  durationWeeks: 8,
};

/** A published project this corporation has pledged to and had accepted. */
async function delivered(
  charity: { userId: string; organisationId: string },
  corp: { userId: string; organisationId: string },
  title: string,
) {
  const { projectId } = await createDraftProject(
    charity.userId,
    {
      charityOrgId: charity.organisationId,
      title,
      description: 'A worthy cause that needs a hand from local people.',
      goal: 'Get it done.',
      category: 'software',
    },
    testDb,
  );
  await setResourceNeeds(charity.userId, projectId, [NEED], testDb);
  await publishProject(charity.userId, projectId, testDb);
  const { pledgeId } = await pledgeResources(
    corp.userId,
    projectId,
    {
      corporationOrgId: corp.organisationId,
      resourceType: 'Dev time',
      quantity: 1,
      durationWeeks: 8,
    },
    testDb,
  );
  const { deliveryWorkspaceId } = await acceptPledge(charity.userId, pledgeId, testDb);
  return { projectId, workspaceId: deliveryWorkspaceId };
}

describe('corporate CSR dashboard (US-7.1)', () => {
  it('totals approved hours across projects, keeping pending separate', async () => {
    const { charity, corp } = await twoOrgs();
    const a = await delivered(charity, corp, 'Garden site');
    const b = await delivered(charity, corp, 'Food bank tool');
    const { userId: volunteer } = await inviteMember(
      corp.userId,
      corp.organisationId,
      'dana@acme.com',
      'volunteer',
      testDb,
    );

    for (const ws of [a.workspaceId, b.workspaceId]) {
      const { allocationId } = await allocateVolunteer(corp.userId, ws, volunteer, 4, testDb);
      const approved = await logHours(volunteer, allocationId, { hours: 5 }, testDb);
      await logHours(volunteer, allocationId, { hours: 2 }, testDb);
      await approveHours(corp.userId, approved.hourLogId, testDb);
    }

    await entitleDashboard(corp.organisationId);
    const impact = await getCorporateImpact(corp.userId, corp.organisationId, testDb);

    // 10 approved across two projects, 4 still pending — never 14.
    expect(impact.hours.approvedHours).toBe(10);
    expect(impact.hours.pendingHours).toBe(4);
    expect(impact.projectsSupported).toBe(2);
  });

  it('never includes another corporation figures', async () => {
    const { charity, corp } = await twoOrgs();
    const mine = await delivered(charity, corp, 'My project');
    const { userId: volunteer } = await inviteMember(
      corp.userId,
      corp.organisationId,
      'dana@acme.com',
      'volunteer',
      testDb,
    );
    const { allocationId } = await allocateVolunteer(
      corp.userId,
      mine.workspaceId,
      volunteer,
      4,
      testDb,
    );
    const log = await logHours(volunteer, allocationId, { hours: 5 }, testDb);
    await approveHours(corp.userId, log.hourLogId, testDb);

    // A second corporation delivers its own project on the same charity.
    const rival = await registerCorporation(
      {
        email: 'rival@rival.com',
        password: 'a-strong-password',
        companyName: 'Rival Ltd',
        emailDomain: 'rival.com',
      },
      testDb,
    );
    const theirs = await delivered(charity, rival, 'Their project');
    const { userId: theirVolunteer } = await inviteMember(
      rival.userId,
      rival.organisationId,
      'sam@rival.com',
      'volunteer',
      testDb,
    );
    const theirAlloc = await allocateVolunteer(
      rival.userId,
      theirs.workspaceId,
      theirVolunteer,
      4,
      testDb,
    );
    const theirLog = await logHours(theirVolunteer, theirAlloc.allocationId, { hours: 40 }, testDb);
    await approveHours(rival.userId, theirLog.hourLogId, testDb);

    await entitleDashboard(corp.organisationId);
    const impact = await getCorporateImpact(corp.userId, corp.organisationId, testDb);

    expect(impact.hours.approvedHours).toBe(5); // not 45
    expect(impact.projectsSupported).toBe(1);
    expect(impact.projects.map((p) => p.title)).not.toContain('Their project');
  });

  it('reports compute spend and runs in their own units, never as hours', async () => {
    const { corp } = await promotableRun();

    await entitleDashboard(corp.organisationId);
    const impact = await getCorporateImpact(corp.userId, corp.organisationId, testDb);

    expect(impact.agentDelivery.runCount).toBe(1);
    expect(impact.agentDelivery.completedRunCount).toBe(1);
    expect(impact.agentDelivery.committedMinor).toBeGreaterThan(0);
    expect(impact.agentDelivery.currency).toBe('GBP');
    // The invariant: agent delivery adds nothing to the donated-time headline.
    expect(impact.hours.approvedHours).toBe(0);
    expect(impact.hours.pendingHours).toBe(0);
  });

  it('surfaces outcome stories of completed projects for reporting', async () => {
    const { charity, corp, projectId } = await promotableRun();
    await completeProject(charity.userId, projectId, STORY, testDb);

    await entitleDashboard(corp.organisationId);
    const impact = await getCorporateImpact(corp.userId, corp.organisationId, testDb);

    expect(impact.outcomes).toHaveLength(1);
    expect(impact.outcomes[0]!.projectId).toBe(projectId);
    expect(impact.outcomes[0]!.outcomeStory).toBe(STORY);
  });

  it('lists no outcomes while nothing has completed', async () => {
    const { corp } = await promotableRun();
    await entitleDashboard(corp.organisationId);
    const impact = await getCorporateImpact(corp.userId, corp.organisationId, testDb);
    expect(impact.outcomes).toEqual([]);
  });

  it('refuses a non-member of the organisation', async () => {
    const { corp, charity } = await twoOrgs();
    await entitleDashboard(corp.organisationId);
    await expect(
      getCorporateImpact(charity.userId, corp.organisationId, testDb),
    ).rejects.toBeInstanceOf(NotFoundError);
  });

  it('refuses a member who is not a CSR manager', async () => {
    const { corp } = await twoOrgs();
    const { userId: volunteer } = await inviteMember(
      corp.userId,
      corp.organisationId,
      'dana@acme.com',
      'volunteer',
      testDb,
    );

    await entitleDashboard(corp.organisationId);
    await expect(getCorporateImpact(volunteer, corp.organisationId, testDb)).rejects.toBeInstanceOf(
      ForbiddenError,
    );
  });

  it('refuses a Starter corporation with an upgrade prompt, not a permission error (US-10.5)', async () => {
    const { corp } = await twoOrgs();

    await expect(
      getCorporateImpact(corp.userId, corp.organisationId, testDb),
    ).rejects.toBeInstanceOf(PlanUpgradeRequiredError);

    // The error names the plan that unlocks it, so a prompt can be concrete.
    try {
      await getCorporateImpact(corp.userId, corp.organisationId, testDb);
      expect.unreachable();
    } catch (e) {
      const err = e as PlanUpgradeRequiredError;
      expect(err.code).toBe('upgrade_required');
      expect(err.requiredPlanCode).toBe('team');
      expect(err.requiredPlanName).toBe('Team');
    }
  });

  it('works for a corporation that has done nothing yet', async () => {
    const fresh = await registerCorporation(
      {
        email: 'new@newco.com',
        password: 'a-strong-password',
        companyName: 'NewCo',
        emailDomain: 'newco.com',
      },
      testDb,
    );

    await entitleDashboard(fresh.organisationId);
    const impact = await getCorporateImpact(fresh.userId, fresh.organisationId, testDb);

    expect(impact.projectsSupported).toBe(0);
    expect(impact.hours.approvedHours).toBe(0);
    expect(impact.agentDelivery.runCount).toBe(0);
    expect(impact.outcomes).toEqual([]);
  });
});
