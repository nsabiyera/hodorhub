import { describe, it, expect, vi } from 'vitest';
import { eq } from 'drizzle-orm';
import { testDb } from '@/test/db';
import { notifications, projects } from '@/db/schema';
import {
  registerCharity,
  registerCorporation,
  approveVerification,
  createPlatformAdmin,
  inviteMember,
  saveMyProfile,
  ForbiddenError,
} from '@/modules/identity';
import { createDraftProject, setResourceNeeds, publishProject } from '@/modules/projects';
import { pledgeResources, acceptPledge } from '@/modules/commitments';

vi.mock('@/lib/mailer', () => ({ mailer: { send: async () => {} } }));

import { relayOutbox } from '@/modules/notifications';
import { allocateVolunteer } from './service';
import { getVolunteerLoad } from './availability';

const need = {
  skill: 'Backend development',
  role: 'Backend developer',
  kind: 'ongoing' as const,
  quantity: 1,
  hoursPerWeek: 2,
  durationWeeks: 8,
};

/** A corporation with an accepted pledge, its workspace, and one volunteer. */
async function scenario(tag: string) {
  const admin = await createPlatformAdmin(`admin-${tag}@hh.com`, 'admin-password-1', testDb);
  const charity = await registerCharity(
    {
      email: `petra-${tag}@goodcause.org`,
      password: 'a-strong-password',
      charityName: `Good Cause ${tag}`,
      regNumber: `CH-${tag}`,
    },
    testDb,
  );
  await approveVerification(charity.verificationRequestId, admin, testDb);
  const { projectId } = await createDraftProject(
    charity.userId,
    {
      charityOrgId: charity.organisationId,
      title: `Project ${tag}`,
      description: 'A worthy community cause that needs a hand from local people.',
      goal: 'Get it done.',
      category: 'software',
    },
    testDb,
  );
  await setResourceNeeds(charity.userId, projectId, [need], testDb);
  await publishProject(charity.userId, projectId, testDb);

  const corp = await registerCorporation(
    {
      email: `carlos-${tag}@acme-${tag}.com`,
      password: 'another-strong-pw',
      companyName: `Acme ${tag}`,
      emailDomain: `acme-${tag}.com`,
    },
    testDb,
  );
  await approveVerification(corp.verificationRequestId, admin, testDb);
  const { pledgeId } = await pledgeResources(
    corp.userId,
    projectId,
    {
      corporationOrgId: corp.organisationId,
      resourceType: 'Dev time',
      quantity: 2,
      durationWeeks: 8,
    },
    testDb,
  );
  const { deliveryWorkspaceId } = await acceptPledge(charity.userId, pledgeId, testDb);
  const volunteer = await inviteMember(
    corp.userId,
    corp.organisationId,
    `dana@acme-${tag}.com`,
    'volunteer',
    testDb,
  );
  return { admin, charity, corp, projectId, workspaceId: deliveryWorkspaceId, volunteer };
}

describe('Volunteer load (US-1.5)', () => {
  it('is "unknown", never zero, for someone who has stated nothing', async () => {
    const s = await scenario('unknown');
    await allocateVolunteer(s.corp.userId, s.workspaceId, s.volunteer.userId, 3, testDb);
    const [load] = await getVolunteerLoad(
      s.corp.userId,
      s.corp.organisationId,
      [s.volunteer.userId],
      testDb,
    );
    expect(load).toMatchObject({
      allocatedHoursPerWeek: 3,
      statedWeeklyHours: null,
      // Unknown is never "over" — that is the whole point of keeping null.
      overAllocated: null,
      overBy: null,
    });
  });

  it('warns rather than refusing, and tells the volunteer', async () => {
    const s = await scenario('over');
    await saveMyProfile(s.volunteer.userId, { weeklyHours: 2, skills: ['carpentry'] }, testDb);

    // The allocation SUCCEEDS: the employer authorises the donation.
    const res = await allocateVolunteer(
      s.corp.userId,
      s.workspaceId,
      s.volunteer.userId,
      5,
      testDb,
    );
    expect(res.allocationId).toBeTruthy();
    expect(res.load).toMatchObject({ overAllocated: true, overBy: 3, statedWeeklyHours: 2 });

    await relayOutbox(testDb);
    const notes = (
      await testDb.query.notifications.findMany({
        where: eq(notifications.userId, s.volunteer.userId),
      })
    ).filter((n) => n.type === 'hours.over_allocated');
    expect(notes).toHaveLength(1);
    // The manager is NOT notified — they made the call and saw the flag.
    const managerNotes = (
      await testDb.query.notifications.findMany({ where: eq(notifications.userId, s.corp.userId) })
    ).filter((n) => n.type === 'hours.over_allocated');
    expect(managerNotes).toHaveLength(0);
  });

  it('does not re-notify when nothing got worse', async () => {
    const s = await scenario('again');
    await saveMyProfile(s.volunteer.userId, { weeklyHours: 2, skills: ['carpentry'] }, testDb);
    await allocateVolunteer(s.corp.userId, s.workspaceId, s.volunteer.userId, 5, testDb);
    await relayOutbox(testDb);
    // Re-allocating DOWN, still over, must not ping them a second time.
    await allocateVolunteer(s.corp.userId, s.workspaceId, s.volunteer.userId, 4, testDb);
    await relayOutbox(testDb);

    const countNotes = async () =>
      (
        await testDb.query.notifications.findMany({
          where: eq(notifications.userId, s.volunteer.userId),
        })
      ).filter((n) => n.type === 'hours.over_allocated').length;
    expect(await countNotes()).toBe(1);

    // Re-allocating to the SAME figure is not a worsening either.
    await allocateVolunteer(s.corp.userId, s.workspaceId, s.volunteer.userId, 4, testDb);
    await relayOutbox(testDb);
    expect(await countNotes()).toBe(1);

    // But going UP again must fire. Without this case, "notify only on the
    // first transition, never again" would pass every other test here — and a
    // volunteer moved from 5 to 25 hours against a stated 2 would never hear.
    await allocateVolunteer(s.corp.userId, s.workspaceId, s.volunteer.userId, 9, testDb);
    await relayOutbox(testDb);
    expect(await countNotes()).toBe(2);
  });

  it('re-allocating replaces the hours rather than stacking them', async () => {
    const s = await scenario('upsert');
    await allocateVolunteer(s.corp.userId, s.workspaceId, s.volunteer.userId, 4, testDb);
    const second = await allocateVolunteer(
      s.corp.userId,
      s.workspaceId,
      s.volunteer.userId,
      6,
      testDb,
    );
    // 6, not 10: a second allocation is a re-allocation, not a second commitment.
    expect(second.load?.allocatedHoursPerWeek).toBe(6);
    const rows = await testDb.query.allocations.findMany();
    expect(rows).toHaveLength(1);
  });

  it('stops counting a project once it is completed', async () => {
    const s = await scenario('done');
    await saveMyProfile(s.volunteer.userId, { weeklyHours: 2, skills: ['carpentry'] }, testDb);
    await allocateVolunteer(s.corp.userId, s.workspaceId, s.volunteer.userId, 5, testDb);

    const before = await getVolunteerLoad(
      s.corp.userId,
      s.corp.organisationId,
      [s.volunteer.userId],
      testDb,
    );
    expect(before[0]!.allocatedHoursPerWeek).toBe(5);

    await testDb.update(projects).set({ status: 'completed' }).where(eq(projects.id, s.projectId));
    // Nothing was deleted — the allocation still exists, it just stopped counting.
    expect(await testDb.query.allocations.findMany()).toHaveLength(1);

    const after = await getVolunteerLoad(
      s.corp.userId,
      s.corp.organisationId,
      [s.volunteer.userId],
      testDb,
    );
    // A finished project no longer consumes anybody's week, so they are no
    // longer over-allocated either.
    expect(after[0]).toMatchObject({ allocatedHoursPerWeek: 0, overAllocated: false });
  });

  it('never sums another employer’s allocations into this one', async () => {
    // Two employers, the same human, allocated by both. A global sum would warn
    // one employer about a constraint they cannot see, and would leak the
    // existence of the other employer through the arithmetic.
    const a = await scenario('empA');
    const b = await scenario('empB');
    await inviteMember(
      b.corp.userId,
      b.corp.organisationId,
      `dana@acme-empA.com`,
      'volunteer',
      testDb,
    );
    await allocateVolunteer(a.corp.userId, a.workspaceId, a.volunteer.userId, 4, testDb);
    await allocateVolunteer(b.corp.userId, b.workspaceId, a.volunteer.userId, 7, testDb);

    const [loadA] = await getVolunteerLoad(
      a.corp.userId,
      a.corp.organisationId,
      [a.volunteer.userId],
      testDb,
    );
    expect(loadA!.allocatedHoursPerWeek).toBe(4);
    // Not 11 — and the workspace list names only this employer's workspace.
    expect(loadA!.liveWorkspaceIds).toEqual([a.workspaceId]);
  });

  it('is refused to a colleague and invisible to an outsider', async () => {
    const s = await scenario('authz');
    await expect(
      getVolunteerLoad(s.volunteer.userId, s.corp.organisationId, [s.volunteer.userId], testDb),
    ).rejects.toBeInstanceOf(ForbiddenError);
    // The charity delivering with this corporation still cannot reach it.
    // The exact message, not just the class: a downstream read throwing its own
    // NotFoundError is precisely what made this shape pass vacuously before.
    await expect(
      getVolunteerLoad(s.charity.userId, s.corp.organisationId, [s.volunteer.userId], testDb),
    ).rejects.toThrow('Organisation not found.');
    await expect(
      getVolunteerLoad(s.admin, s.corp.organisationId, [s.volunteer.userId], testDb),
    ).rejects.toThrow('Organisation not found.');
  });
});
