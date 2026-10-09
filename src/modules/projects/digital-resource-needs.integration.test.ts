import { describe, it, expect } from 'vitest';
import { eq } from 'drizzle-orm';
import { testDb } from '@/test/db';
import { digitalResourceNeeds } from '@/db/schema';
import { registerCharity, approveVerification, createPlatformAdmin } from '@/modules/identity';
import {
  createDraftProject,
  setResourceNeeds,
  publishProject,
  setDigitalResourceNeeds,
  getPublishedProject,
} from './service';

const need = {
  skill: 'Backend development',
  role: 'Backend developer',
  kind: 'ongoing' as const,
  quantity: 1,
  hoursPerWeek: 2,
  durationWeeks: 8,
};

async function publishedProject() {
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
      description: 'A worthy cause that needs a hand.',
      goal: 'Reach the finish line.',
      category: 'software',
    },
    testDb,
  );
  await setResourceNeeds(charity.userId, projectId, [need], testDb);
  await publishProject(charity.userId, projectId, testDb);
  return { charity, projectId };
}

describe('Projects — digital-resource needs (US-2.7)', () => {
  it('declares digital-resource needs with optional quantity+unit and exposes them on the read model', async () => {
    const { charity, projectId } = await publishedProject();
    await setDigitalResourceNeeds(
      charity.userId,
      projectId,
      [
        { kind: 'saas_seats', description: 'GitHub Team seats', quantity: 5, unit: 'seats' },
        { kind: 'cloud_credits', description: 'AWS credits for hosting' },
      ],
      testDb,
    );
    const rows = await testDb.query.digitalResourceNeeds.findMany({
      where: eq(digitalResourceNeeds.projectId, projectId),
    });
    expect(rows).toHaveLength(2);
    const seats = rows.find((r) => r.kind === 'saas_seats');
    expect(seats?.quantity).toBe(5);
    expect(seats?.unit).toBe('seats');
    const credits = rows.find((r) => r.kind === 'cloud_credits');
    expect(credits?.quantity).toBeNull(); // no monetary value, quantity optional

    const pub = await getPublishedProject(projectId, testDb);
    expect(pub?.digitalResourceNeeds).toHaveLength(2);
  });

  it('replaces the set (replace-all, like time needs)', async () => {
    const { charity, projectId } = await publishedProject();
    await setDigitalResourceNeeds(charity.userId, projectId, [{ kind: 'domains' }], testDb);
    await setDigitalResourceNeeds(
      charity.userId,
      projectId,
      [{ kind: 'llm_budget', unit: 'USD credits' }],
      testDb,
    );
    const rows = await testDb.query.digitalResourceNeeds.findMany({
      where: eq(digitalResourceNeeds.projectId, projectId),
    });
    expect(rows).toHaveLength(1);
    expect(rows[0]!.kind).toBe('llm_budget');
  });

  it('rejects an unknown kind', async () => {
    const { charity, projectId } = await publishedProject();
    await expect(
      // @ts-expect-error invalid kind
      setDigitalResourceNeeds(charity.userId, projectId, [{ kind: 'bitcoins' }], testDb),
    ).rejects.toBeInstanceOf(Error);
  });
});
