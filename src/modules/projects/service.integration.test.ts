import { describe, it, expect } from 'vitest';
import { eq } from 'drizzle-orm';
import { testDb } from '@/test/db';
import { projects, projectResourceNeeds, memberships } from '@/db/schema';
import {
  registerCharity,
  approveVerification,
  createPlatformAdmin,
  ForbiddenError,
  NotFoundError,
  NotVerifiedError,
} from '@/modules/identity';
import {
  createDraftProject,
  updateDraftProject,
  setResourceNeeds,
  publishProject,
  transitionProjectStatus,
  completeProject,
  getPublishedProject,
} from './service';
import {
  InvalidProjectTransitionError,
  ProjectValidationError,
  NoResourceNeedsError,
} from './errors';

const need = {
  skill: 'Backend development',
  role: 'Backend developer',
  kind: 'ongoing' as const,
  quantity: 1,
  hoursPerWeek: 2,
  durationWeeks: 8,
};

// Register a charity and return { ownerId, orgId, verificationRequestId }.
async function newCharity(email = 'petra@goodcause.org') {
  const r = await registerCharity(
    { email, password: 'a-strong-password', charityName: 'Good Cause', regNumber: 'CH-1' },
    testDb,
  );
  return r;
}

async function verifiedCharity(email = 'petra@goodcause.org') {
  const admin = await createPlatformAdmin(`admin-${email}`, 'admin-password-1', testDb);
  const r = await newCharity(email);
  await approveVerification(r.verificationRequestId, admin, testDb);
  return r;
}

async function completeDraft(ownerId: string, orgId: string) {
  const { projectId } = await createDraftProject(
    ownerId,
    {
      charityOrgId: orgId,
      title: 'Rebuild the community garden',
      description: 'A lovely project to rebuild the community garden for everyone to enjoy.',
      goal: 'Reopen the garden by spring.',
      category: 'software',
    },
    testDb,
  );
  await setResourceNeeds(ownerId, projectId, [need], testDb);
  return projectId;
}

describe('Projects — create & resource needs (US-2.1, US-2.2)', () => {
  it('creates a draft (title-only allowed) that is not publicly visible', async () => {
    const { userId, organisationId } = await newCharity();
    const { projectId } = await createDraftProject(
      userId,
      { charityOrgId: organisationId, title: 'Draft only' },
      testDb,
    );
    const row = await testDb.query.projects.findFirst({ where: eq(projects.id, projectId) });
    expect(row?.status).toBe('draft');
    expect(await getPublishedProject(projectId, testDb)).toBeNull(); // drafts not public
  });

  it('persists structured resource needs, replace-all', async () => {
    const { userId, organisationId } = await newCharity();
    const { projectId } = await createDraftProject(
      userId,
      { charityOrgId: organisationId, title: 'Needs test' },
      testDb,
    );
    await setResourceNeeds(
      userId,
      projectId,
      [need, { ...need, kind: 'sprint', hoursPerWeek: 20, durationWeeks: 2 }],
      testDb,
    );
    let rows = await testDb.query.projectResourceNeeds.findMany({
      where: eq(projectResourceNeeds.projectId, projectId),
    });
    expect(rows).toHaveLength(2);
    expect(rows.map((r) => r.kind).sort()).toEqual(['ongoing', 'sprint']);
    await setResourceNeeds(userId, projectId, [need], testDb); // replace-all
    rows = await testDb.query.projectResourceNeeds.findMany({
      where: eq(projectResourceNeeds.projectId, projectId),
    });
    expect(rows).toHaveLength(1);
  });

  it('rejects an invalid resource need (bad kind / out-of-range hours)', async () => {
    const { userId, organisationId } = await newCharity();
    const { projectId } = await createDraftProject(
      userId,
      { charityOrgId: organisationId, title: 'Needs validation' },
      testDb,
    );
    await expect(
      setResourceNeeds(userId, projectId, [{ ...need, hoursPerWeek: 999 }], testDb),
    ).rejects.toThrow();
  });
});

describe('Projects — publish (US-2.1)', () => {
  it('publishes a complete draft for a verified charity and emits ProjectPublished', async () => {
    const { userId, organisationId } = await verifiedCharity();
    const projectId = await completeDraft(userId, organisationId);

    await publishProject(userId, projectId, testDb);
    const row = await testDb.query.projects.findFirst({ where: eq(projects.id, projectId) });
    expect(row?.status).toBe('published');
    expect(row?.publishedAt).not.toBeNull();
    const events = (await testDb.query.outbox.findMany()).map((e) => e.eventType);
    expect(events).toContain('ProjectPublished');
    expect(await getPublishedProject(projectId, testDb)).not.toBeNull(); // now public
  });

  it('blocks publish for an UNVERIFIED charity (US-1.1 gate)', async () => {
    const { userId, organisationId } = await newCharity();
    const projectId = await completeDraft(userId, organisationId);
    await expect(publishProject(userId, projectId, testDb)).rejects.toBeInstanceOf(
      NotVerifiedError,
    );
  });

  it('blocks publish with missing fields (field-level) and with no resource needs', async () => {
    const { userId, organisationId } = await verifiedCharity();
    // missing description + goal
    const { projectId } = await createDraftProject(
      userId,
      { charityOrgId: organisationId, title: 'Bare' },
      testDb,
    );
    await setResourceNeeds(userId, projectId, [need], testDb);
    await expect(publishProject(userId, projectId, testDb)).rejects.toBeInstanceOf(
      ProjectValidationError,
    );

    // complete text, but zero needs
    const { projectId: p2 } = await createDraftProject(
      userId,
      {
        charityOrgId: organisationId,
        title: 'No needs',
        description: 'x'.repeat(25),
        goal: 'y'.repeat(15),
        category: 'software',
      },
      testDb,
    );
    await expect(publishProject(userId, p2, testDb)).rejects.toBeInstanceOf(NoResourceNeedsError);
  });

  it('blocks publish without a category (US-2.6)', async () => {
    const { userId, organisationId } = await verifiedCharity();
    const { projectId } = await createDraftProject(
      userId,
      {
        charityOrgId: organisationId,
        title: 'Uncategorised project',
        description: 'x'.repeat(25),
        goal: 'y'.repeat(15),
      },
      testDb,
    );
    await setResourceNeeds(userId, projectId, [need], testDb);
    await expect(publishProject(userId, projectId, testDb)).rejects.toBeInstanceOf(
      ProjectValidationError,
    );
  });

  it('persists a chosen category on the project (US-2.6)', async () => {
    const { userId, organisationId } = await newCharity();
    const { projectId } = await createDraftProject(
      userId,
      { charityOrgId: organisationId, title: 'Category test', category: 'design' },
      testDb,
    );
    const row = await testDb.query.projects.findFirst({ where: eq(projects.id, projectId) });
    expect(row?.category).toBe('design');
  });

  it('rejects re-publishing an already-published project (idempotent, no dup event)', async () => {
    const { userId, organisationId } = await verifiedCharity();
    const projectId = await completeDraft(userId, organisationId);
    await publishProject(userId, projectId, testDb);
    await expect(publishProject(userId, projectId, testDb)).rejects.toBeInstanceOf(
      InvalidProjectTransitionError,
    );
    const published = (await testDb.query.outbox.findMany()).filter(
      (e) => e.eventType === 'ProjectPublished',
    );
    expect(published).toHaveLength(1);
  });
});

describe('Projects — lifecycle (US-2.4)', () => {
  it('runs published → in_delivery → completed → archived and rejects skips', async () => {
    const { userId, organisationId } = await verifiedCharity();
    const projectId = await completeDraft(userId, organisationId);
    await publishProject(userId, projectId, testDb);

    await transitionProjectStatus(userId, projectId, 'in_delivery', testDb);
    // illegal skip
    await expect(
      transitionProjectStatus(userId, projectId, 'draft', testDb),
    ).rejects.toBeInstanceOf(InvalidProjectTransitionError);
    // US-7.3 — completion carries an outcome story, so it has its own operation.
    await completeProject(
      userId,
      projectId,
      'We delivered the site and 400 people signed up.',
      testDb,
    );
    await transitionProjectStatus(userId, projectId, 'archived', testDb);
    const row = await testDb.query.projects.findFirst({ where: eq(projects.id, projectId) });
    expect(row?.status).toBe('archived');
    // archived is terminal
    await expect(
      transitionProjectStatus(userId, projectId, 'published', testDb),
    ).rejects.toBeInstanceOf(InvalidProjectTransitionError);
  });

  it('re-opens in_delivery back to published', async () => {
    const { userId, organisationId } = await verifiedCharity();
    const projectId = await completeDraft(userId, organisationId);
    await publishProject(userId, projectId, testDb);
    await transitionProjectStatus(userId, projectId, 'in_delivery', testDb);
    await transitionProjectStatus(userId, projectId, 'published', testDb);
    const row = await testDb.query.projects.findFirst({ where: eq(projects.id, projectId) });
    expect(row?.status).toBe('published');
  });
});

describe('Projects — resource-need invariants & events', () => {
  it('rejects removing the last need on a published project (AC-2.2.6)', async () => {
    const { userId, organisationId } = await verifiedCharity();
    const projectId = await completeDraft(userId, organisationId);
    await publishProject(userId, projectId, testDb);
    await expect(setResourceNeeds(userId, projectId, [], testDb)).rejects.toBeInstanceOf(
      NoResourceNeedsError,
    );
  });

  it('blocks resource-need edits once in_delivery (edit window)', async () => {
    const { userId, organisationId } = await verifiedCharity();
    const projectId = await completeDraft(userId, organisationId);
    await publishProject(userId, projectId, testDb);
    await transitionProjectStatus(userId, projectId, 'in_delivery', testDb);
    await expect(setResourceNeeds(userId, projectId, [need], testDb)).rejects.toThrow(
      /draft or published/,
    );
  });

  it('emits ProjectUpdated when a published project’s needs change', async () => {
    const { userId, organisationId } = await verifiedCharity();
    const projectId = await completeDraft(userId, organisationId);
    await publishProject(userId, projectId, testDb);
    await setResourceNeeds(
      userId,
      projectId,
      [need, { ...need, role: 'Frontend developer' }],
      testDb,
    );
    const events = (await testDb.query.outbox.findMany()).map((e) => e.eventType);
    expect(events).toContain('ProjectUpdated');
  });

  it('archived projects are not publicly visible (AC-2.4.7)', async () => {
    const { userId, organisationId } = await verifiedCharity();
    const { projectId } = await createDraftProject(
      userId,
      { charityOrgId: organisationId, title: 'To be archived' },
      testDb,
    );
    await transitionProjectStatus(userId, projectId, 'archived', testDb);
    expect(await getPublishedProject(projectId, testDb)).toBeNull();
  });

  it('reopen (in_delivery→published) does NOT re-emit ProjectPublished or reset publishedAt', async () => {
    const { userId, organisationId } = await verifiedCharity();
    const projectId = await completeDraft(userId, organisationId);
    await publishProject(userId, projectId, testDb);
    const first = await testDb.query.projects.findFirst({ where: eq(projects.id, projectId) });

    await transitionProjectStatus(userId, projectId, 'in_delivery', testDb);
    await transitionProjectStatus(userId, projectId, 'published', testDb); // reopen

    const published = (await testDb.query.outbox.findMany()).filter(
      (e) => e.eventType === 'ProjectPublished',
    );
    expect(published).toHaveLength(1); // still only the first publish
    const after = await testDb.query.projects.findFirst({ where: eq(projects.id, projectId) });
    expect(after?.publishedAt?.getTime()).toBe(first?.publishedAt?.getTime()); // unchanged
  });

  it('rejects draft field values below length bounds (US-2.1 validation)', async () => {
    const { userId, organisationId } = await newCharity();
    await expect(
      createDraftProject(userId, { charityOrgId: organisationId, title: 'no' }, testDb),
    ).rejects.toThrow();
  });
});

describe('Projects — authorization & tenant isolation (US-2.1 AC-2.1.7)', () => {
  it('a different charity cannot see or act on another org project (NotFound, no leak)', async () => {
    const a = await verifiedCharity('petra@goodcause.org');
    const projectId = await completeDraft(a.userId, a.organisationId);
    const b = await verifiedCharity('otto@otherorg.org');

    await expect(getPublishedProjectAsOwner(b.userId, projectId)).rejects.toBeInstanceOf(
      NotFoundError,
    );
    await expect(
      transitionProjectStatus(b.userId, projectId, 'published', testDb),
    ).rejects.toBeInstanceOf(NotFoundError);
  });

  it('a non-owner member of the same org is Forbidden (not NotFound)', async () => {
    const { userId, organisationId } = await verifiedCharity();
    const projectId = await completeDraft(userId, organisationId);

    // A volunteer in the SAME org: has a membership, but wrong role → Forbidden.
    const volunteerId = await createPlatformAdmin('vol@goodcause.org', 'password-1234', testDb);
    await testDb
      .insert(memberships)
      .values({ userId: volunteerId, organisationId, role: 'volunteer' });

    await expect(
      updateDraftProject(volunteerId, projectId, { title: 'Sneaky edit attempt' }, testDb),
    ).rejects.toBeInstanceOf(ForbiddenError);
  });
});

// helper that forces the owner-scoped read path
async function getPublishedProjectAsOwner(userId: string, projectId: string) {
  const { getProjectForOwner } = await import('./service');
  return getProjectForOwner(userId, projectId, testDb);
}
