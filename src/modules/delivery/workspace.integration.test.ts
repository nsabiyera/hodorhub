import { describe, it, expect } from 'vitest';
import { eq } from 'drizzle-orm';
import { testDb } from '@/test/db';
import { deliveryMilestones, deliveryTasks, notifications } from '@/db/schema';
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
import { allocateVolunteer, logHours, approveHours } from './service';
import {
  createMilestone,
  achieveMilestone,
  createTask,
  updateTask,
  getWorkspaceBoard,
  getDeliveryProgress,
} from './workspace';

const need = {
  skill: 'Backend development',
  role: 'Backend developer',
  kind: 'ongoing' as const,
  quantity: 1,
  hoursPerWeek: 2,
  durationWeeks: 8,
};

/**
 * The whole loop up to an accepted pledge, plus one allocated volunteer.
 * `tag` keeps emails and registration numbers unique so a single test can build
 * two independent workspaces (needed to prove cross-workspace leakage is shut).
 */
async function scenario(tag = 'a') {
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
      email: `carlos-${tag}@acme-${tag}.com`,
      password: 'another-strong-pw',
      companyName: `Acme ${tag} Ltd`,
      emailDomain: `acme-${tag}.com`,
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
  const { userId: volunteerId } = await inviteMember(
    corp.userId,
    corp.organisationId,
    `dana@acme-${tag}.com`,
    'volunteer',
    testDb,
  );
  const { allocationId } = await allocateVolunteer(
    corp.userId,
    deliveryWorkspaceId,
    volunteerId,
    2,
    testDb,
  );
  return {
    admin,
    charity,
    corp,
    projectId,
    volunteerId,
    allocationId,
    workspaceId: deliveryWorkspaceId,
  };
}

const isoDay = (offsetDays: number) =>
  new Date(Date.now() + offsetDays * 86_400_000).toISOString().slice(0, 10);

describe('Delivery workspace — the shared board (US-6.3)', () => {
  it('both organisations read the same board; outsiders and platform admins get 404', async () => {
    const s = await scenario();
    await createMilestone(s.charity.userId, s.workspaceId, { title: 'Phase one' }, testDb);
    await createTask(s.corp.userId, s.workspaceId, { title: 'Set up the repo' }, testDb);

    const charityView = await getWorkspaceBoard(s.charity.userId, s.workspaceId, testDb);
    const corpView = await getWorkspaceBoard(s.corp.userId, s.workspaceId, testDb);
    const volunteerView = await getWorkspaceBoard(s.volunteerId, s.workspaceId, testDb);

    // Same board, different capabilities.
    expect(charityView.milestones.map((m) => m.title)).toEqual(['Phase one']);
    expect(corpView.milestones).toEqual(charityView.milestones);
    expect(volunteerView.tasks.map((t) => t.title)).toEqual(['Set up the repo']);
    expect(charityView.project.goal).toBe('Reopen the garden by spring.');
    expect(charityView.viewer).toMatchObject({ side: 'charity', canManageMilestones: true });
    expect(corpView.viewer).toMatchObject({ side: 'corporation', canManageMilestones: false });
    expect(volunteerView.viewer).toMatchObject({
      canManageMilestones: false,
      canManageTasks: false,
      allocationIds: [s.allocationId],
    });

    // A rival corporation on its own project learns nothing about this one.
    // The message is asserted, not just the type: several reads downstream also
    // raise NotFoundError, and this test has to prove the *participation* check
    // rejected them rather than passing on a lucky secondary throw.
    const other = await scenario('b');
    await expect(getWorkspaceBoard(other.corp.userId, s.workspaceId, testDb)).rejects.toThrow(
      'Delivery workspace not found.',
    );
    await expect(
      getWorkspaceBoard(other.corp.userId, s.workspaceId, testDb),
    ).rejects.toBeInstanceOf(NotFoundError);
    // Platform admin is not a participant (same call as US-7.1).
    await expect(getWorkspaceBoard(s.admin, s.workspaceId, testDb)).rejects.toThrow(
      'Delivery workspace not found.',
    );
  });

  it('only the charity owner creates milestones', async () => {
    const s = await scenario();
    await expect(
      createMilestone(s.corp.userId, s.workspaceId, { title: 'Phase one' }, testDb),
    ).rejects.toBeInstanceOf(ForbiddenError);
    await expect(
      createMilestone(s.volunteerId, s.workspaceId, { title: 'Phase one' }, testDb),
    ).rejects.toBeInstanceOf(ForbiddenError);
    const { milestoneId } = await createMilestone(
      s.charity.userId,
      s.workspaceId,
      { title: 'Phase one', dueOn: isoDay(7) },
      testDb,
    );
    const row = await testDb.query.deliveryMilestones.findFirst({
      where: eq(deliveryMilestones.id, milestoneId),
    });
    expect(row?.status).toBe('open');
    expect(row?.dueOn).toBe(isoDay(7));
  });

  it('either coordinator adds a task; a volunteer cannot', async () => {
    const s = await scenario();
    await expect(
      createTask(s.volunteerId, s.workspaceId, { title: 'Sneak a task in' }, testDb),
    ).rejects.toBeInstanceOf(ForbiddenError);
    await createTask(s.charity.userId, s.workspaceId, { title: 'Charity task' }, testDb);
    await createTask(s.corp.userId, s.workspaceId, { title: 'Corp task' }, testDb);
    const board = await getWorkspaceBoard(s.charity.userId, s.workspaceId, testDb);
    expect(board.tasks).toHaveLength(2);
  });

  it('a task can only be assigned to a volunteer allocated to THIS workspace', async () => {
    const s = await scenario();
    const other = await scenario('b');
    await expect(
      createTask(
        s.corp.userId,
        s.workspaceId,
        { title: 'Borrowed hands', assignedAllocationId: other.allocationId },
        testDb,
      ),
    ).rejects.toBeInstanceOf(InvalidStateError);
    // …and a task cannot be filed under another workspace's milestone.
    const foreign = await createMilestone(
      other.charity.userId,
      other.workspaceId,
      { title: 'Their phase' },
      testDb,
    );
    await expect(
      createTask(
        s.corp.userId,
        s.workspaceId,
        { title: 'Wrong phase', milestoneId: foreign.milestoneId },
        testDb,
      ),
    ).rejects.toBeInstanceOf(InvalidStateError);
  });

  it('a volunteer moves their own task and nothing else, and never reassigns', async () => {
    const s = await scenario();
    const { userId: other } = await inviteMember(
      s.corp.userId,
      s.corp.organisationId,
      'eve@acme-a.com',
      'volunteer',
      testDb,
    );
    const otherAlloc = await allocateVolunteer(s.corp.userId, s.workspaceId, other, 3, testDb);

    const mine = await createTask(
      s.corp.userId,
      s.workspaceId,
      { title: 'Mine', assignedAllocationId: s.allocationId },
      testDb,
    );
    const theirs = await createTask(
      s.corp.userId,
      s.workspaceId,
      { title: 'Theirs', assignedAllocationId: otherAlloc.allocationId },
      testDb,
    );
    const loose = await createTask(s.corp.userId, s.workspaceId, { title: 'Nobody' }, testDb);

    await updateTask(s.volunteerId, mine.taskId, { status: 'in_progress' }, testDb);
    await expect(
      updateTask(s.volunteerId, theirs.taskId, { status: 'done' }, testDb),
    ).rejects.toBeInstanceOf(ForbiddenError);
    await expect(
      updateTask(s.volunteerId, loose.taskId, { status: 'done' }, testDb),
    ).rejects.toBeInstanceOf(ForbiddenError);
    // Reassignment is a coordinator's decision, never the assignee's.
    await expect(
      updateTask(
        s.volunteerId,
        mine.taskId,
        { assignedAllocationId: otherAlloc.allocationId },
        testDb,
      ),
    ).rejects.toBeInstanceOf(ForbiddenError);

    const moved = await testDb.query.deliveryTasks.findFirst({
      where: eq(deliveryTasks.id, mine.taskId),
    });
    expect(moved?.status).toBe('in_progress');
  });

  it('moving a task out of done clears its completion date', async () => {
    const s = await scenario();
    const { taskId } = await createTask(s.corp.userId, s.workspaceId, { title: 'Ship it' }, testDb);
    await updateTask(s.corp.userId, taskId, { status: 'done' }, testDb);
    const done = await testDb.query.deliveryTasks.findFirst({
      where: eq(deliveryTasks.id, taskId),
    });
    expect(done?.completedAt).toBeInstanceOf(Date);

    await updateTask(s.corp.userId, taskId, { status: 'in_progress' }, testDb);
    const reopened = await testDb.query.deliveryTasks.findFirst({
      where: eq(deliveryTasks.id, taskId),
    });
    expect(reopened?.completedAt).toBeNull();
  });

  it('all tasks done means AWAITING the charity, not achieved; only the charity confirms', async () => {
    const s = await scenario();
    const { milestoneId } = await createMilestone(
      s.charity.userId,
      s.workspaceId,
      { title: 'Phase one' },
      testDb,
    );
    const t1 = await createTask(
      s.corp.userId,
      s.workspaceId,
      { title: 'One', milestoneId },
      testDb,
    );
    const t2 = await createTask(
      s.corp.userId,
      s.workspaceId,
      { title: 'Two', milestoneId },
      testDb,
    );

    let board = await getWorkspaceBoard(s.corp.userId, s.workspaceId, testDb);
    expect(board.milestones[0]).toMatchObject({
      status: 'open',
      readyToConfirm: false,
      taskCounts: { todo: 2, inProgress: 0, done: 0 },
    });

    await updateTask(s.corp.userId, t1.taskId, { status: 'done' }, testDb);
    await updateTask(s.corp.userId, t2.taskId, { status: 'done' }, testDb);
    board = await getWorkspaceBoard(s.corp.userId, s.workspaceId, testDb);
    // The corporation finished the work; the milestone is still NOT achieved.
    expect(board.milestones[0]).toMatchObject({ status: 'open', readyToConfirm: true });

    await expect(achieveMilestone(s.corp.userId, milestoneId, testDb)).rejects.toBeInstanceOf(
      ForbiddenError,
    );
    await achieveMilestone(s.charity.userId, milestoneId, testDb);
    const row = await testDb.query.deliveryMilestones.findFirst({
      where: eq(deliveryMilestones.id, milestoneId),
    });
    expect(row?.status).toBe('achieved');
    expect(row?.achievedBy).toBe(s.charity.userId);
    expect(row?.achievedAt).toBeInstanceOf(Date);
    // Confirming twice is a conflict, not a silent second write.
    await expect(achieveMilestone(s.charity.userId, milestoneId, testDb)).rejects.toBeInstanceOf(
      InvalidStateError,
    );

    board = await getWorkspaceBoard(s.charity.userId, s.workspaceId, testDb);
    expect(board.milestones[0]).toMatchObject({ status: 'achieved', readyToConfirm: false });
  });

  it('an empty milestone is never "ready to confirm"', async () => {
    const s = await scenario();
    await createMilestone(s.charity.userId, s.workspaceId, { title: 'Nothing yet' }, testDb);
    const board = await getWorkspaceBoard(s.charity.userId, s.workspaceId, testDb);
    expect(board.milestones[0]).toMatchObject({ readyToConfirm: false, status: 'open' });
  });

  it('notifies the assigned volunteer, and the corporation when the charity confirms', async () => {
    const s = await scenario();
    const { milestoneId } = await createMilestone(
      s.charity.userId,
      s.workspaceId,
      { title: 'Phase one' },
      testDb,
    );
    await createTask(
      s.corp.userId,
      s.workspaceId,
      { title: 'Assigned work', milestoneId, assignedAllocationId: s.allocationId },
      testDb,
    );
    await achieveMilestone(s.charity.userId, milestoneId, testDb);
    await relayOutbox(testDb);

    const volunteerNotes = await testDb.query.notifications.findMany({
      where: eq(notifications.userId, s.volunteerId),
    });
    expect(volunteerNotes.map((n) => n.type)).toContain('delivery_task.assigned');
    const corpNotes = await testDb.query.notifications.findMany({
      where: eq(notifications.userId, s.corp.userId),
    });
    expect(corpNotes.map((n) => n.type)).toContain('delivery_milestone.achieved');
  });

  it('reassigning an existing task notifies the new volunteer', async () => {
    const s = await scenario();
    const { taskId } = await createTask(s.corp.userId, s.workspaceId, { title: 'Later' }, testDb);
    await updateTask(s.corp.userId, taskId, { assignedAllocationId: s.allocationId }, testDb);
    await relayOutbox(testDb);
    const notes = await testDb.query.notifications.findMany({
      where: eq(notifications.userId, s.volunteerId),
    });
    expect(notes.map((n) => n.type)).toContain('delivery_task.assigned');

    // Unassigning is a valid change and notifies nobody new.
    await updateTask(s.corp.userId, taskId, { assignedAllocationId: null }, testDb);
    const task = await testDb.query.deliveryTasks.findFirst({
      where: eq(deliveryTasks.id, taskId),
    });
    expect(task?.assignedAllocationId).toBeNull();
  });
});

describe('Delivery progress against the goal (US-6.4)', () => {
  it('says nothing is in delivery rather than showing an empty board at 0%', async () => {
    const s = await scenario();
    const { projectId } = await createDraftProject(
      s.charity.userId,
      {
        charityOrgId: s.charity.organisationId,
        title: 'A second, untouched project',
        description: 'Nothing has been pledged against this one yet at all.',
        goal: 'Run a winter coat drive.',
        category: 'operations',
      },
      testDb,
    );
    const progress = await getDeliveryProgress(s.charity.userId, projectId, testDb);
    expect(progress.inDelivery).toBe(false);
    expect(progress.goal).toBe('Run a winter coat drive.');
    expect(progress).not.toHaveProperty('milestoneSummary');
  });

  it('reads progress against the goal, flags overdue, and never sums the three effort figures', async () => {
    const s = await scenario();
    const late = await createMilestone(
      s.charity.userId,
      s.workspaceId,
      { title: 'Was due last week', dueOn: isoDay(-7) },
      testDb,
    );
    const soon = await createMilestone(
      s.charity.userId,
      s.workspaceId,
      { title: 'Due next week', dueOn: isoDay(7) },
      testDb,
    );
    const doneMilestone = await createMilestone(
      s.charity.userId,
      s.workspaceId,
      { title: 'Already signed off', dueOn: isoDay(-14) },
      testDb,
    );
    await achieveMilestone(s.charity.userId, doneMilestone.milestoneId, testDb);

    await createTask(
      s.corp.userId,
      s.workspaceId,
      { title: 'Late work', milestoneId: late.milestoneId },
      testDb,
    );
    const scheduled = await createTask(
      s.corp.userId,
      s.workspaceId,
      { title: 'Upcoming work', milestoneId: soon.milestoneId },
      testDb,
    );
    await updateTask(s.corp.userId, scheduled.taskId, { status: 'done' }, testDb);
    await createTask(s.corp.userId, s.workspaceId, { title: 'Unfiled work' }, testDb);

    // 3 approved hours and 5 still pending, against 2 allocated hours/week.
    const approved = await logHours(s.volunteerId, s.allocationId, { hours: 3 }, testDb);
    await approveHours(s.corp.userId, approved.hourLogId, testDb);
    await logHours(s.volunteerId, s.allocationId, { hours: 5 }, testDb);

    const progress = await getDeliveryProgress(s.charity.userId, s.projectId, testDb);
    if (!progress.inDelivery) throw new Error('expected the project to be in delivery');
    expect(progress.goal).toBe('Reopen the garden by spring.');
    expect(progress.milestoneSummary).toEqual({
      total: 3,
      achieved: 1,
      awaitingConfirmation: 1, // "Due next week" — all its tasks done, charity not yet asked
      overdue: 1, // only the open one; the signed-off one is not late
    });
    expect(progress.unscheduledTasks).toEqual({ todo: 1, inProgress: 0, done: 0 });
    expect(progress.effort).toEqual({
      allocatedHoursPerWeek: 2,
      approvedHours: 3,
      pendingHours: 5,
      volunteerCount: 1,
    });
    // The point of three figures: nothing anywhere reports 8 hours delivered.
    expect(Object.values(progress.effort)).not.toContain(8);
  });

  it('is the charity owner’s read only', async () => {
    const s = await scenario();
    const other = await scenario('b');
    // The delivering corporation has the board; progress is the charity's view.
    await expect(getDeliveryProgress(s.corp.userId, s.projectId, testDb)).rejects.toBeInstanceOf(
      NotFoundError,
    );
    await expect(
      getDeliveryProgress(other.charity.userId, s.projectId, testDb),
    ).rejects.toBeInstanceOf(NotFoundError);
    await expect(getDeliveryProgress(s.admin, s.projectId, testDb)).rejects.toBeInstanceOf(
      NotFoundError,
    );
  });

  it('another corporation delivering the same charity never appears in this project’s progress', async () => {
    const s = await scenario();
    const rival = await registerCorporation(
      {
        email: 'rival@rival.com',
        password: 'a-third-strong-pw',
        companyName: 'Rival Ltd',
        emailDomain: 'rival.com',
      },
      testDb,
    );
    // The rival delivers a DIFFERENT project of the same charity.
    const { projectId: otherProject } = await createDraftProject(
      s.charity.userId,
      {
        charityOrgId: s.charity.organisationId,
        title: 'A different project entirely',
        description: 'Another project of the same charity, delivered by someone else.',
        goal: 'Digitise the archive.',
        category: 'software',
      },
      testDb,
    );
    await setResourceNeeds(s.charity.userId, otherProject, [need], testDb);
    await publishProject(s.charity.userId, otherProject, testDb);
    const { pledgeId } = await pledgeResources(
      rival.userId,
      otherProject,
      {
        corporationOrgId: rival.organisationId,
        resourceType: 'Dev time',
        quantity: 2,
        durationWeeks: 8,
      },
      testDb,
    );
    const rivalWs = await acceptPledge(s.charity.userId, pledgeId, testDb);
    await createMilestone(
      s.charity.userId,
      rivalWs.deliveryWorkspaceId,
      { title: 'Rival phase' },
      testDb,
    );

    const progress = await getDeliveryProgress(s.charity.userId, s.projectId, testDb);
    if (!progress.inDelivery) throw new Error('expected the project to be in delivery');
    expect(progress.milestoneSummary.total).toBe(0);
    expect(progress.workspaceIds).toEqual([s.workspaceId]);
  });
});
