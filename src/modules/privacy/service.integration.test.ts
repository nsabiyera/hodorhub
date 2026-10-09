import { describe, it, expect } from 'vitest';
import { eq } from 'drizzle-orm';
import { testDb } from '@/test/db';
import { users, onPlatformSupports, projectScores, engagementEvents } from '@/db/schema';
import { registerCharity, approveVerification, createPlatformAdmin } from '@/modules/identity';
import { createDraftProject, setResourceNeeds, publishProject } from '@/modules/projects';
import { supportProject, ingestEngagement, confirmPendingEngagement } from '@/modules/engagement';
import { eraseUser, purgeEngagementOlderThan } from './service';

const need = {
  skill: 'Backend development',
  role: 'Backend developer',
  kind: 'ongoing' as const,
  quantity: 1,
  hoursPerWeek: 2,
  durationWeeks: 8,
};

async function publishedProject() {
  const admin = await createPlatformAdmin('alex@hodorhub.com', 'admin-password-1', testDb);
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
      description: 'A worthy cause needing a hand.',
      goal: 'Reopen by spring.',
      category: 'software',
    },
    testDb,
  );
  await setResourceNeeds(charity.userId, projectId, [need], testDb);
  await publishProject(charity.userId, projectId, testDb);
  return { projectId };
}

describe('Privacy — consent, erasure, retention (GDPR)', () => {
  it('captures consent at signup', async () => {
    const r = await registerCharity(
      {
        email: 'c@c.org',
        password: 'a-strong-password',
        charityName: 'Consent Co',
        regNumber: 'CH-9',
      },
      testDb,
    );
    const user = await testDb.query.users.findFirst({ where: eq(users.id, r.userId) });
    expect(user?.consentedAt).not.toBeNull();
  });

  it('erases a user: anonymised, support removed, score re-derived', async () => {
    const { projectId } = await publishedProject();
    const fan = await createPlatformAdmin('fan@x.com', 'password-1234', testDb);
    await supportProject(fan, projectId, testDb);
    let score = await testDb.query.projectScores.findFirst({
      where: eq(projectScores.projectId, projectId),
    });
    expect(score?.rawR).toBe(1);

    await eraseUser(fan, testDb);

    const user = await testDb.query.users.findFirst({ where: eq(users.id, fan) });
    expect(user?.email).toBe(`erased-${fan}@erased.invalid`);
    expect(user?.deletedAt).not.toBeNull();
    expect(
      await testDb.query.onPlatformSupports.findMany({ where: eq(onPlatformSupports.userId, fan) }),
    ).toHaveLength(0);
    score = await testDb.query.projectScores.findFirst({
      where: eq(projectScores.projectId, projectId),
    });
    expect(score?.rawR).toBe(0); // support removed → score re-derived
  });

  it('purges ingested social engagement older than the cutoff and re-derives the score', async () => {
    const { projectId } = await publishedProject();
    await ingestEngagement(
      projectId,
      [
        {
          source: 'facebook',
          action: 'share',
          externalEventId: 'old-1',
          occurredAt: '2020-01-01T00:00:00Z',
          trust: 90,
        },
      ],
      testDb,
    );
    await confirmPendingEngagement(projectId, testDb);
    let score = await testDb.query.projectScores.findFirst({
      where: eq(projectScores.projectId, projectId),
    });
    expect(score!.rawR).toBeGreaterThan(0);

    const { purged } = await purgeEngagementOlderThan(new Date('2021-01-01T00:00:00Z'), testDb);
    expect(purged).toBe(1);
    expect(
      await testDb.query.engagementEvents.findMany({
        where: eq(engagementEvents.projectId, projectId),
      }),
    ).toHaveLength(0);
    score = await testDb.query.projectScores.findFirst({
      where: eq(projectScores.projectId, projectId),
    });
    expect(score?.rawR).toBe(0);
  });
});
