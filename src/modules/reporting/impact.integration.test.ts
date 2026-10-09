import { describe, it, expect } from 'vitest';
import { testDb } from '@/test/db';
import { NotFoundError, inviteMember, registerCharity } from '@/modules/identity';
import {
  completeProject,
  createDraftProject,
  setResourceNeeds,
  publishProject,
} from '@/modules/projects';
import { pledgeResources, acceptPledge } from '@/modules/commitments';
import { logHours, approveHours, allocateVolunteer } from '@/modules/delivery';
import { promotableRun, twoOrgs } from '@/test/agent-delivery-fixtures';
import { getProjectImpact } from './service';

const STORY = 'The site launched in March and 412 local volunteers signed up in the first month.';

describe('charity impact summary (US-7.2)', () => {
  it('reports support, hours, gifts and the outcome for a project I own', async () => {
    const { charity, projectId } = await promotableRun();

    const impact = await getProjectImpact(charity.userId, projectId, testDb);

    expect(impact.project.id).toBe(projectId);
    expect(impact.support.supporterCount).toBeGreaterThanOrEqual(0);
    expect(typeof impact.support.supportScore).toBe('number');
    expect(impact.hours.approvedHours).toBe(0);
    expect(impact.gifts.receivedCount).toBe(0);
  });

  it('counts only approved hours, keeping pending as its own figure', async () => {
    const { charity, corp, projectId, volunteerUserId, workspaceId } = await humanDelivery();

    const { allocationId } = await allocateVolunteer(
      corp.userId,
      workspaceId,
      volunteerUserId,
      4,
      testDb,
    );
    const first = await logHours(volunteerUserId, allocationId, { hours: 5 }, testDb);
    await logHours(volunteerUserId, allocationId, { hours: 3 }, testDb);
    await approveHours(corp.userId, first.hourLogId, testDb);

    const impact = await getProjectImpact(charity.userId, projectId, testDb);

    // 5 approved, 3 still pending — never 8.
    expect(impact.hours.approvedHours).toBe(5);
    expect(impact.hours.pendingHours).toBe(3);
  });

  it('shows the outcome story once the project is complete', async () => {
    const { charity, projectId } = await promotableRun();
    await completeProject(charity.userId, projectId, STORY, testDb);

    const impact = await getProjectImpact(charity.userId, projectId, testDb);

    expect(impact.project.status).toBe('completed');
    expect(impact.project.outcomeStory).toBe(STORY);
    expect(impact.project.completedAt).not.toBeNull();
  });

  it('works on a project still in delivery, with no outcome yet', async () => {
    const { charity, projectId } = await promotableRun();

    const impact = await getProjectImpact(charity.userId, projectId, testDb);

    expect(impact.project.outcomeStory).toBeNull();
    expect(impact.project.completedAt).toBeNull();
  });

  it('reports agent delivery as its own line, never as hours or support', async () => {
    const { charity, projectId } = await promotableRun();

    const impact = await getProjectImpact(charity.userId, projectId, testDb);

    expect(impact.agentDelivery).not.toBeNull();
    expect(impact.agentDelivery!.milestonesApproved).toBeGreaterThan(0);
    expect(impact.agentDelivery!.stagingUrl).toContain('http');
    // The whole point: agent work inflates neither donated hours nor support.
    expect(impact.hours.approvedHours).toBe(0);
    expect(impact.support.supportScore).toBe(0);
    // And carries no compute currency (Epic 7 decision 4).
    expect(JSON.stringify(impact.agentDelivery)).not.toMatch(/Minor|budget|pence|currency/i);
  });

  it('has no agent-delivery line on a project no agent ever touched', async () => {
    const { charity, projectId } = await humanDelivery();
    const impact = await getProjectImpact(charity.userId, projectId, testDb);
    expect(impact.agentDelivery).toBeNull();
  });

  it('hides a project owned by another charity', async () => {
    const { projectId } = await promotableRun();
    const outsider = await registerCharity(
      {
        email: 'nosy@elsewhere.org',
        password: 'a-strong-password',
        charityName: 'Elsewhere',
        regNumber: 'CH-ELSE-1',
      },
      testDb,
    );

    await expect(getProjectImpact(outsider.userId, projectId, testDb)).rejects.toBeInstanceOf(
      NotFoundError,
    );
  });

  it('hides the summary from the funding corporation', async () => {
    const { corp, projectId } = await promotableRun();

    await expect(getProjectImpact(corp.userId, projectId, testDb)).rejects.toBeInstanceOf(
      NotFoundError,
    );
  });
});

/** A published project with an accepted human pledge, a workspace and a volunteer. */
async function humanDelivery() {
  const { charity, corp } = await twoOrgs();
  const { projectId } = await createDraftProject(
    charity.userId,
    {
      charityOrgId: charity.organisationId,
      title: 'Community garden site',
      description: 'A worthy cause that needs a hand from local people.',
      goal: 'Get it built.',
      category: 'software',
    },
    testDb,
  );
  await setResourceNeeds(
    charity.userId,
    projectId,
    [
      {
        skill: 'Backend',
        role: 'Dev',
        kind: 'ongoing',
        quantity: 1,
        hoursPerWeek: 4,
        durationWeeks: 8,
      },
    ],
    testDb,
  );
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
  const { userId: volunteerUserId } = await inviteMember(
    corp.userId,
    corp.organisationId,
    'dana@acme.com',
    'volunteer',
    testDb,
  );
  return { charity, corp, projectId, workspaceId: deliveryWorkspaceId, volunteerUserId };
}
