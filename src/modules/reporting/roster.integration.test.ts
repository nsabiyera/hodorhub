import { describe, it, expect } from 'vitest';
import { testDb } from '@/test/db';
import {
  registerCharity,
  registerCorporation,
  approveVerification,
  createPlatformAdmin,
  inviteMember,
  saveMyProfile,
  setDisplayName,
  ForbiddenError,
} from '@/modules/identity';
import { createDraftProject, setResourceNeeds, publishProject } from '@/modules/projects';
import { pledgeResources, acceptPledge } from '@/modules/commitments';
import { allocateVolunteer, getWorkspaceBoard, getDeliveryProgress } from '@/modules/delivery';
import { getVolunteerRoster } from './roster';

const need = {
  skill: 'Backend development',
  role: 'Backend developer',
  kind: 'ongoing' as const,
  quantity: 1,
  hoursPerWeek: 2,
  durationWeeks: 8,
};

const SECRET_SKILL = 'charity-governance';

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

describe('Volunteer roster (US-1.5)', () => {
  it('composes offered hours, skills and carried load into one view', async () => {
    const s = await scenario('roster');
    await setDisplayName(s.volunteer.userId, 'Dana Okafor', testDb);
    await saveMyProfile(
      s.volunteer.userId,
      { weeklyHours: 6, skills: [SECRET_SKILL], seniority: 'lead' },
      testDb,
    );
    await allocateVolunteer(s.corp.userId, s.workspaceId, s.volunteer.userId, 4, testDb);

    const { entries } = await getVolunteerRoster(s.corp.userId, s.corp.organisationId, testDb);
    const dana = entries.find((e) => e.userId === s.volunteer.userId)!;
    expect(dana).toMatchObject({
      label: 'Dana Okafor',
      email: `dana@acme-roster.com`,
      weeklyHours: 6,
      allocatedHoursPerWeek: 4,
      overAllocated: false,
      hasProfile: true,
    });
    expect(dana.skills.map((k) => k.code)).toEqual([SECRET_SKILL]);
    expect(dana.seniority).toMatchObject({ code: 'lead' });
  });

  it('shows "nobody said" as null, never as zero hours offered', async () => {
    const s = await scenario('nul');
    await allocateVolunteer(s.corp.userId, s.workspaceId, s.volunteer.userId, 3, testDb);
    const { entries } = await getVolunteerRoster(s.corp.userId, s.corp.organisationId, testDb);
    const dana = entries.find((e) => e.userId === s.volunteer.userId)!;
    // Two different facts: they carry 3 hours, and they have said nothing.
    expect(dana.allocatedHoursPerWeek).toBe(3);
    expect(dana.weeklyHours).toBeNull();
    expect(dana.overAllocated).toBeNull();
    expect(dana.hasProfile).toBe(false);
  });

  it('never leaks a volunteer’s profile to the charity, on any surface', async () => {
    const s = await scenario('leak');
    await setDisplayName(s.volunteer.userId, 'Dana Okafor', testDb);
    await saveMyProfile(
      s.volunteer.userId,
      { weeklyHours: 1, skills: [SECRET_SKILL], seniority: 'executive', note: 'A private note.' },
      testDb,
    );
    await allocateVolunteer(s.corp.userId, s.workspaceId, s.volunteer.userId, 9, testDb);

    // The charity cannot reach the roster at all — they hold no membership.
    await expect(
      getVolunteerRoster(s.charity.userId, s.corp.organisationId, testDb),
    ).rejects.toThrow('Organisation not found.');

    // And the surfaces they CAN reach gained no new fields. Serialised and
    // searched rather than field-by-field, so a future addition is caught too.
    const board = await getWorkspaceBoard(s.charity.userId, s.workspaceId, testDb);
    const progress = await getDeliveryProgress(s.charity.userId, s.projectId, testDb);
    for (const surface of [board, progress]) {
      const json = JSON.stringify(surface);
      expect(json).not.toContain(SECRET_SKILL);
      expect(json).not.toContain('executive');
      expect(json).not.toContain('A private note.');
      expect(json).not.toContain('Dana Okafor');
      expect(json).not.toContain('overAllocated');
    }
    // The charity still sees the neutral label US-6.3 promised.
    expect(JSON.stringify(board)).toContain('Volunteer 1');
  });

  it('is refused to a colleague and invisible to an outsider or a platform admin', async () => {
    const s = await scenario('authz2');
    await expect(
      getVolunteerRoster(s.volunteer.userId, s.corp.organisationId, testDb),
    ).rejects.toBeInstanceOf(ForbiddenError);
    // Exact message: the guard that must throw is Identity's membership check,
    // not some downstream read raising a NotFoundError of its own.
    await expect(getVolunteerRoster(s.admin, s.corp.organisationId, testDb)).rejects.toThrow(
      'Organisation not found.',
    );
  });
});
