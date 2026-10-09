import { describe, it, expect } from 'vitest';
import { eq } from 'drizzle-orm';
import { testDb } from '@/test/db';
import { projectScores } from '@/db/schema';
import {
  registerCharity,
  approveVerification,
  createPlatformAdmin,
  InvalidStateError,
} from '@/modules/identity';
import { createDraftProject, setResourceNeeds, publishProject } from '@/modules/projects';
import { supportProject, unsupportProject, getSupportInfo } from './service';
import { listProjects } from '@/modules/discovery';

const need = {
  skill: 'Backend development',
  role: 'Backend developer',
  kind: 'ongoing' as const,
  quantity: 1,
  hoursPerWeek: 2,
  durationWeeks: 8,
};

let seq = 0;
async function publishedProject(title = 'Rebuild the community garden') {
  seq += 1;
  const admin = await createPlatformAdmin(`admin${seq}@hh.com`, 'admin-password-1', testDb);
  const charity = await registerCharity(
    {
      email: `petra${seq}@goodcause.org`,
      password: 'a-strong-password',
      charityName: 'Good Cause',
      regNumber: `CH-${seq}`,
    },
    testDb,
  );
  await approveVerification(charity.verificationRequestId, admin, testDb);
  const { projectId } = await createDraftProject(
    charity.userId,
    {
      charityOrgId: charity.organisationId,
      title,
      description: 'A worthy cause that needs a hand from the community.',
      goal: 'Reach the finish line.',
      category: 'software',
    },
    testDb,
  );
  await setResourceNeeds(charity.userId, projectId, [need], testDb);
  await publishProject(charity.userId, projectId, testDb);
  return { charity, projectId };
}

async function supporter(email: string) {
  return createPlatformAdmin(email, 'password-1234', testDb); // any user can support
}

describe('Engagement — support (US-3.3)', () => {
  it('support increments the count and materialises the score; undo decrements', async () => {
    const { projectId } = await publishedProject();
    const u1 = await supporter('s1@x.com');
    const u2 = await supporter('s2@x.com');

    await supportProject(u1, projectId, testDb);
    await supportProject(u2, projectId, testDb);
    let info = await getSupportInfo(projectId, u1, testDb);
    expect(info.supportCount).toBe(2);
    expect(info.supported).toBe(true);

    const score = await testDb.query.projectScores.findFirst({
      where: eq(projectScores.projectId, projectId),
    });
    expect(score?.rawR).toBe(2);
    expect(score?.supportScore).toBeGreaterThan(0);

    await unsupportProject(u1, projectId, testDb);
    info = await getSupportInfo(projectId, u1, testDb);
    expect(info.supportCount).toBe(1);
    expect(info.supported).toBe(false);
  });

  it('support is idempotent (one per user)', async () => {
    const { projectId } = await publishedProject();
    const u1 = await supporter('dup@x.com');
    await supportProject(u1, projectId, testDb);
    const { supportCount } = await supportProject(u1, projectId, testDb);
    expect(supportCount).toBe(1);
  });

  it('cannot support a non-public (draft) project', async () => {
    const admin = await createPlatformAdmin('adminX@hh.com', 'admin-password-1', testDb);
    const charity = await registerCharity(
      {
        email: 'draftonly@c.org',
        password: 'a-strong-password',
        charityName: 'Draft Co',
        regNumber: 'CH-D',
      },
      testDb,
    );
    await approveVerification(charity.verificationRequestId, admin, testDb);
    const { projectId } = await createDraftProject(
      charity.userId,
      { charityOrgId: charity.organisationId, title: 'Hidden draft' },
      testDb,
    );
    const u = await supporter('nope@x.com');
    await expect(supportProject(u, projectId, testDb)).rejects.toBeInstanceOf(InvalidStateError);
  });
});

describe('Discovery — browse & rank by support (US-4.1, US-4.2)', () => {
  it('lists only published projects, ranked by support score (merit, not money)', async () => {
    const a = await publishedProject('Alpha garden');
    const b = await publishedProject('Beta shelter');

    // b gets more support than a → b must rank first
    await supportProject(await supporter('b1@x.com'), b.projectId, testDb);
    await supportProject(await supporter('b2@x.com'), b.projectId, testDb);
    await supportProject(await supporter('a1@x.com'), a.projectId, testDb);

    const list = await listProjects({ sort: 'support' }, testDb);
    const ids = list.map((r) => r.id);
    expect(ids.indexOf(b.projectId)).toBeLessThan(ids.indexOf(a.projectId));
    expect(list.find((r) => r.id === b.projectId)!.supportScore).toBeGreaterThan(
      list.find((r) => r.id === a.projectId)!.supportScore,
    );
  });

  it('filters by category (US-2.6) without affecting merit ranking', async () => {
    const admin = await createPlatformAdmin('adminCat@hh.com', 'admin-password-1', testDb);
    const charity = await registerCharity(
      {
        email: 'cat@c.org',
        password: 'a-strong-password',
        charityName: 'Cat Co',
        regNumber: 'CH-CAT',
      },
      testDb,
    );
    await approveVerification(charity.verificationRequestId, admin, testDb);
    const pub = async (title: string, category: 'software' | 'design') => {
      const { projectId } = await createDraftProject(
        charity.userId,
        {
          charityOrgId: charity.organisationId,
          title,
          description: 'x'.repeat(25),
          goal: 'y'.repeat(12),
          category,
        },
        testDb,
      );
      await setResourceNeeds(charity.userId, projectId, [need], testDb);
      await publishProject(charity.userId, projectId, testDb);
      return projectId;
    };
    const soft = await pub('Build a volunteer rota tool', 'software');
    const design = await pub('Design a new logo', 'design');

    const results = await listProjects({ category: 'software' }, testDb);
    const ids = results.map((r) => r.id);
    expect(ids).toContain(soft);
    expect(ids).not.toContain(design);
    expect(results.every((r) => r.category === 'software')).toBe(true);
  });

  it('excludes drafts and filters by title query', async () => {
    const admin = await createPlatformAdmin('adminF@hh.com', 'admin-password-1', testDb);
    const charity = await registerCharity(
      {
        email: 'f@c.org',
        password: 'a-strong-password',
        charityName: 'Filter Co',
        regNumber: 'CH-F',
      },
      testDb,
    );
    await approveVerification(charity.verificationRequestId, admin, testDb);
    await createDraftProject(
      charity.userId,
      { charityOrgId: charity.organisationId, title: 'Secret draft' },
      testDb,
    );
    const pub = await publishedProject('Unique searchable title');

    const all = await listProjects({}, testDb);
    expect(all.some((r) => r.title === 'Secret draft')).toBe(false); // draft hidden

    const filtered = await listProjects({ q: 'searchable' }, testDb);
    expect(filtered.map((r) => r.id)).toContain(pub.projectId);
    expect(filtered.every((r) => r.title.toLowerCase().includes('searchable'))).toBe(true);
  });
});
