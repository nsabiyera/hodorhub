import { describe, it, expect } from 'vitest';
import { eq } from 'drizzle-orm';
import { testDb } from '@/test/db';
import { outbox, projects } from '@/db/schema';
import {
  registerCharity,
  approveVerification,
  createPlatformAdmin,
  NotFoundError,
} from '@/modules/identity';
import {
  createDraftProject,
  setResourceNeeds,
  publishProject,
  transitionProjectStatus,
  completeProject,
  getPublishedProject,
  InvalidProjectTransitionError,
  ProjectValidationError,
} from '.';

const STORY = 'The site launched in March and 400 local volunteers signed up in the first month.';

async function projectInDelivery() {
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
  const project = await createDraftProject(
    charity.userId,
    {
      charityOrgId: charity.organisationId,
      title: 'Litter-pick signup site',
      description: 'A worthy cause that needs a hand from local people.',
      goal: 'Get people signed up.',
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
  await transitionProjectStatus(charity.userId, project.projectId, 'in_delivery', testDb);
  return { charity, projectId: project.projectId };
}

describe('project completion with an outcome story (US-7.3)', () => {
  it('completes the project and records the story and the date', async () => {
    const { charity, projectId } = await projectInDelivery();

    await completeProject(charity.userId, projectId, STORY, testDb);

    const row = await testDb.query.projects.findFirst({ where: eq(projects.id, projectId) });
    expect(row!.status).toBe('completed');
    expect(row!.outcomeStory).toBe(STORY);
    expect(row!.completedAt).not.toBeNull();
  });

  it('trims the story before storing it', async () => {
    const { charity, projectId } = await projectInDelivery();
    await completeProject(charity.userId, projectId, `   ${STORY}   `, testDb);
    const row = await testDb.query.projects.findFirst({ where: eq(projects.id, projectId) });
    expect(row!.outcomeStory).toBe(STORY);
  });

  it('refuses completion without a substantive outcome, leaving the project in delivery', async () => {
    const { charity, projectId } = await projectInDelivery();

    for (const story of ['', '   ', 'Done.', 'a'.repeat(29)]) {
      await expect(
        completeProject(charity.userId, projectId, story, testDb),
      ).rejects.toBeInstanceOf(ProjectValidationError);
    }
    const row = await testDb.query.projects.findFirst({ where: eq(projects.id, projectId) });
    expect(row!.status).toBe('in_delivery');
    expect(row!.outcomeStory).toBeNull();
  });

  it('closes the status-only route to completed, so no project completes without a result', async () => {
    const { charity, projectId } = await projectInDelivery();

    await expect(
      transitionProjectStatus(charity.userId, projectId, 'completed', testDb),
    ).rejects.toThrow(/completeProject/);

    const row = await testDb.query.projects.findFirst({ where: eq(projects.id, projectId) });
    expect(row!.status).toBe('in_delivery');
  });

  it('refuses completion from a state that cannot reach completed', async () => {
    const { charity, projectId } = await projectInDelivery();
    await transitionProjectStatus(charity.userId, projectId, 'published', testDb);

    await expect(completeProject(charity.userId, projectId, STORY, testDb)).rejects.toBeInstanceOf(
      InvalidProjectTransitionError,
    );
  });

  it('refuses a second completion — the outcome is a published record', async () => {
    const { charity, projectId } = await projectInDelivery();
    await completeProject(charity.userId, projectId, STORY, testDb);

    await expect(
      completeProject(charity.userId, projectId, 'A different story about what happened.', testDb),
    ).rejects.toBeInstanceOf(InvalidProjectTransitionError);
    const row = await testDb.query.projects.findFirst({ where: eq(projects.id, projectId) });
    expect(row!.outcomeStory).toBe(STORY);
  });

  it('refuses someone outside the owning charity', async () => {
    const { projectId } = await projectInDelivery();
    const outsider = await registerCharity(
      {
        email: 'other@elsewhere.org',
        password: 'a-strong-password',
        charityName: 'Elsewhere',
        regNumber: 'CH-2',
      },
      testDb,
    );

    await expect(completeProject(outsider.userId, projectId, STORY, testDb)).rejects.toBeInstanceOf(
      NotFoundError,
    );
  });

  it('emits ProjectCompleted alongside the status change', async () => {
    const { charity, projectId } = await projectInDelivery();
    await completeProject(charity.userId, projectId, STORY, testDb);

    const completed = await testDb
      .select()
      .from(outbox)
      .where(eq(outbox.eventType, 'ProjectCompleted'));
    expect(completed).toHaveLength(1);
    const payload = completed[0]!.payload as Record<string, unknown>;
    expect(payload.projectId).toBe(projectId);
    expect(payload.charityOrgId).toBe(charity.organisationId);
    expect(payload.outcomeStory).toBe(STORY);

    const statusChanges = await testDb
      .select()
      .from(outbox)
      .where(eq(outbox.eventType, 'ProjectStatusChanged'));
    expect(statusChanges.some((e) => (e.payload as { to?: string }).to === 'completed')).toBe(true);
  });

  it('shows the outcome on the public read, so supporters see the result', async () => {
    const { charity, projectId } = await projectInDelivery();
    await completeProject(charity.userId, projectId, STORY, testDb);

    const publicView = await getPublishedProject(projectId, testDb);
    expect(publicView!.status).toBe('completed');
    expect(publicView!.outcomeStory).toBe(STORY);
  });
});
