import { describe, it, expect } from 'vitest';
import { eq } from 'drizzle-orm';
import { testDb } from '@/test/db';
import { allocations, hourLogs, memberships, notifications } from '@/db/schema';
import {
  registerCharity,
  registerCorporation,
  approveVerification,
  createPlatformAdmin,
  inviteMember,
  ForbiddenError,
  NotFoundError,
  InvalidStateError,
} from '@/modules/identity';
import { createDraftProject, setResourceNeeds, publishProject } from '@/modules/projects';
import { pledgeResources, acceptPledge } from '@/modules/commitments';
import { relayOutbox } from '@/modules/notifications';
import {
  allocateVolunteer,
  logHours,
  approveHours,
  rejectHours,
  getWorkspaceHours,
} from './service';

const need = {
  skill: 'Backend development',
  role: 'Backend developer',
  kind: 'ongoing' as const,
  quantity: 1,
  hoursPerWeek: 2,
  durationWeeks: 8,
};

// Build the loop up to an accepted pledge → returns the delivery workspace + actors.
async function acceptedWorkspace() {
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
  await approveVerification(charity.verificationRequestId, admin, testDb);
  const { projectId } = await createDraftProject(
    charity.userId,
    {
      charityOrgId: charity.organisationId,
      title: 'Rebuild the community garden',
      description: 'Rebuild the community garden for the neighbourhood to enjoy again.',
      goal: 'Reopen the garden by spring.',
      category: 'software',
    },
    testDb,
  );
  await setResourceNeeds(charity.userId, projectId, [need], testDb);
  await publishProject(charity.userId, projectId, testDb);

  const corp = await registerCorporation(
    {
      email: 'carlos@acme.com',
      password: 'another-strong-pw',
      companyName: 'Acme Ltd',
      emailDomain: 'acme.com',
    },
    testDb,
  );
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
  return { charity, corp, workspaceId: deliveryWorkspaceId };
}

describe('Volunteer enablement (US-1.4 minimal)', () => {
  it('a CSR manager invites a volunteer into their org', async () => {
    const { corp } = await acceptedWorkspace();
    const { userId, membershipCreated } = await inviteMember(
      corp.userId,
      corp.organisationId,
      'dana@acme.com',
      'volunteer',
      testDb,
    );
    expect(membershipCreated).toBe(true);
    const m = await testDb.query.memberships.findFirst({ where: eq(memberships.userId, userId) });
    expect(m?.role).toBe('volunteer');
    // idempotent
    const again = await inviteMember(
      corp.userId,
      corp.organisationId,
      'dana@acme.com',
      'volunteer',
      testDb,
    );
    expect(again.membershipCreated).toBe(false);
  });

  it('a non-admin cannot invite', async () => {
    const { corp } = await acceptedWorkspace();
    const outsider = await createPlatformAdmin('out@x.com', 'password-1234', testDb);
    await expect(
      inviteMember(outsider, corp.organisationId, 'x@acme.com', 'volunteer', testDb),
    ).rejects.toBeInstanceOf(NotFoundError);
  });
});

describe('Delivery — allocate, log, approve (US-6.1/6.2/6.2a)', () => {
  async function withVolunteer() {
    const base = await acceptedWorkspace();
    const { userId: volunteerId } = await inviteMember(
      base.corp.userId,
      base.corp.organisationId,
      'dana@acme.com',
      'volunteer',
      testDb,
    );
    return { ...base, volunteerId };
  }

  it('allocates a volunteer, who logs PENDING hours that do NOT count until approved', async () => {
    const { corp, workspaceId, volunteerId } = await withVolunteer();
    const { allocationId } = await allocateVolunteer(
      corp.userId,
      workspaceId,
      volunteerId,
      2,
      testDb,
    );
    const alloc = await testDb.query.allocations.findFirst({
      where: eq(allocations.id, allocationId),
    });
    expect(alloc?.volunteerUserId).toBe(volunteerId);

    await logHours(volunteerId, allocationId, { hours: 3, note: 'Set up CI' }, testDb);
    let totals = await getWorkspaceHours(corp.userId, workspaceId, testDb);
    expect(totals.pendingHours).toBe(3);
    expect(totals.approvedHours).toBe(0); // US-6.2a: pending never counts

    const log = totals.logs[0]!;
    await approveHours(corp.userId, log.id, testDb);
    totals = await getWorkspaceHours(corp.userId, workspaceId, testDb);
    expect(totals.approvedHours).toBe(3);
    expect(totals.pendingHours).toBe(0);
  });

  it('only the allocated volunteer can log their own hours', async () => {
    const { corp, workspaceId, volunteerId } = await withVolunteer();
    const { allocationId } = await allocateVolunteer(
      corp.userId,
      workspaceId,
      volunteerId,
      2,
      testDb,
    );
    // the CSR manager is not the volunteer → cannot log
    await expect(logHours(corp.userId, allocationId, { hours: 1 }, testDb)).rejects.toBeInstanceOf(
      ForbiddenError,
    );
  });

  it('cannot allocate a volunteer who is not a member of the corporation', async () => {
    const { corp, workspaceId } = await withVolunteer();
    const stranger = await createPlatformAdmin('stranger@x.com', 'password-1234', testDb);
    await expect(
      allocateVolunteer(corp.userId, workspaceId, stranger, 2, testDb),
    ).rejects.toBeInstanceOf(InvalidStateError);
  });

  it('rejecting hours records a reason and notifies the volunteer; they do not count', async () => {
    const { corp, workspaceId, volunteerId } = await withVolunteer();
    const { allocationId } = await allocateVolunteer(
      corp.userId,
      workspaceId,
      volunteerId,
      2,
      testDb,
    );
    const { hourLogId } = await logHours(volunteerId, allocationId, { hours: 5 }, testDb);
    await rejectHours(corp.userId, hourLogId, 'Please split into weekly entries', testDb);

    const log = await testDb.query.hourLogs.findFirst({ where: eq(hourLogs.id, hourLogId) });
    expect(log?.status).toBe('rejected');
    const totals = await getWorkspaceHours(corp.userId, workspaceId, testDb);
    expect(totals.approvedHours).toBe(0);
    await relayOutbox(testDb); // event → notification
    const notes = await testDb.query.notifications.findMany({
      where: eq(notifications.userId, volunteerId),
    });
    expect(notes.some((n) => n.type === 'hours.rejected')).toBe(true);
  });

  it('cannot approve already-decided hours; requires a reason to reject', async () => {
    const { corp, workspaceId, volunteerId } = await withVolunteer();
    const { allocationId } = await allocateVolunteer(
      corp.userId,
      workspaceId,
      volunteerId,
      2,
      testDb,
    );
    const { hourLogId } = await logHours(volunteerId, allocationId, { hours: 2 }, testDb);
    await approveHours(corp.userId, hourLogId, testDb);
    await expect(approveHours(corp.userId, hourLogId, testDb)).rejects.toBeInstanceOf(
      InvalidStateError,
    );
    const { hourLogId: h2 } = await logHours(volunteerId, allocationId, { hours: 1 }, testDb);
    await expect(rejectHours(corp.userId, h2, '  ', testDb)).rejects.toBeInstanceOf(
      InvalidStateError,
    );
  });
});
