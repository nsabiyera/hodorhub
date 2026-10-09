import { describe, it, expect } from 'vitest';
import { eq } from 'drizzle-orm';
import { testDb } from '@/test/db';
import { projectScores } from '@/db/schema';
import {
  registerCharity,
  registerCorporation,
  approveVerification,
  createPlatformAdmin,
} from '@/modules/identity';
import { createDraftProject, setResourceNeeds, publishProject } from '@/modules/projects';
import { supportProject } from '@/modules/engagement';
import { listProjects } from '@/modules/discovery';
import {
  offerResourceGift,
  acceptResourceGift,
  markResourceGiftProvided,
  confirmResourceGiftReceived,
} from '@/modules/commitments';

const need = {
  skill: 'Backend',
  role: 'Backend dev',
  kind: 'ongoing' as const,
  quantity: 1,
  hoursPerWeek: 2,
  durationWeeks: 8,
};

async function setup() {
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
  const corp = await registerCorporation(
    {
      email: 'carlos@acme.com',
      password: 'a-strong-password',
      companyName: 'Acme',
      emailDomain: 'acme.com',
    },
    testDb,
  );
  await approveVerification(corp.verificationRequestId, admin, testDb);
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
  return { charity, corp, projectId };
}

describe('US-RG — resource gifts are merit-blind and marketplace-neutral', () => {
  it('offering→accepting→providing→receiving a gift never changes the score or rank', async () => {
    const { charity, corp, projectId } = await setup();
    const supporter = await createPlatformAdmin('fan@x.com', 'password-1234', testDb);
    await supportProject(supporter, projectId, testDb); // establish a real baseline score

    const before = await testDb.query.projectScores.findFirst({
      where: eq(projectScores.projectId, projectId),
    });
    const rankBefore = (await listProjects({ sort: 'support' }, testDb)).map((r) => r.id);

    const { giftId } = await offerResourceGift(
      corp.userId,
      projectId,
      {
        corporationOrgId: corp.organisationId,
        kind: 'cloud_credits',
        quantity: 100000,
        unit: 'USD credits',
      },
      testDb,
    );
    await acceptResourceGift(charity.userId, giftId, testDb);
    await markResourceGiftProvided(corp.userId, giftId, testDb);
    await confirmResourceGiftReceived(charity.userId, giftId, testDb);

    const after = await testDb.query.projectScores.findFirst({
      where: eq(projectScores.projectId, projectId),
    });
    expect(after?.rawR).toBe(before?.rawR);
    expect(after?.supportScore).toBe(before?.supportScore);
    expect(after?.momentumScore).toBe(before?.momentumScore);

    const rankAfter = (await listProjects({ sort: 'support' }, testDb)).map((r) => r.id);
    expect(rankAfter).toEqual(rankBefore);
  });
});
