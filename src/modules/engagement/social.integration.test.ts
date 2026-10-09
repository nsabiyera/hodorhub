import { describe, it, expect } from 'vitest';
import { eq } from 'drizzle-orm';
import { testDb } from '@/test/db';
import { socialConnections, engagementEvents, projectScores } from '@/db/schema';
import { registerCharity, approveVerification, createPlatformAdmin } from '@/modules/identity';
import { createDraftProject, setResourceNeeds, publishProject } from '@/modules/projects';
import {
  connectSocialAccount,
  ingestEngagement,
  confirmPendingEngagement,
  supportProject,
} from './index';

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
      description: 'A worthy community cause that needs a hand.',
      goal: 'Reopen by spring.',
      category: 'software',
    },
    testDb,
  );
  await setResourceNeeds(charity.userId, projectId, [need], testDb);
  await publishProject(charity.userId, projectId, testDb);
  return { charity, projectId };
}

const events = [
  {
    source: 'facebook' as const,
    action: 'share',
    externalEventId: 'fb-1',
    occurredAt: '2026-07-01T00:00:00Z',
    trust: 90,
  }, // credible → ev 4
  {
    source: 'facebook' as const,
    action: 'share',
    externalEventId: 'fb-2',
    occurredAt: '2026-07-01T00:00:00Z',
    trust: 20,
  }, // bot-like → flagged
];

describe('Social ingestion (US-3.4/3.5, US-9.3)', () => {
  it('connect stores the token ENCRYPTED at rest', async () => {
    const { charity, projectId } = await publishedProject();
    const { connectionId } = await connectSocialAccount(
      charity.userId,
      projectId,
      'facebook',
      'super-secret-oauth-token',
      'post-123',
      testDb,
    );
    const conn = await testDb.query.socialConnections.findFirst({
      where: eq(socialConnections.id, connectionId),
    });
    expect(conn?.tokenCiphertext).toBeTruthy();
    expect(conn?.tokenCiphertext).not.toContain('super-secret-oauth-token'); // encrypted
  });

  it('ingests provisional events idempotently', async () => {
    const { projectId } = await publishedProject();
    const first = await ingestEngagement(projectId, events, testDb);
    expect(first.ingested).toBe(2);
    const again = await ingestEngagement(projectId, events, testDb); // same externalEventIds
    expect(again.ingested).toBe(0); // no double-count
    const rows = await testDb.query.engagementEvents.findMany({
      where: eq(engagementEvents.projectId, projectId),
    });
    expect(rows).toHaveLength(2);
    expect(rows.every((r) => r.status === 'provisional')).toBe(true);
  });

  it('anti-gaming: only trustworthy engagement is confirmed and counts toward the score', async () => {
    const { projectId } = await publishedProject();
    await ingestEngagement(projectId, events, testDb);
    const { confirmed, flagged } = await confirmPendingEngagement(projectId, testDb);
    expect(confirmed).toBe(1); // trust 90
    expect(flagged).toBe(1); // trust 20 → dampened

    // R counts ONLY the confirmed share (weight 4 × trust 90% = 4); the flagged one is excluded.
    const score = await testDb.query.projectScores.findFirst({
      where: eq(projectScores.projectId, projectId),
    });
    expect(score?.rawR).toBe(4);
    expect(score!.supportScore).toBeGreaterThan(0);
  });

  it('flags a bot-like burst from one actor even when trust is high (velocity, US-9.3)', async () => {
    const { projectId } = await publishedProject();
    // 4 high-trust events all from the SAME actor → exceeds MAX_EVENTS_PER_ACTOR (3).
    const burst = Array.from({ length: 4 }, (_, i) => ({
      source: 'twitter' as const,
      action: 'like',
      actorRef: 'bot-actor-1',
      externalEventId: `burst-${i}`,
      occurredAt: '2026-07-01T00:00:00Z',
      trust: 95,
    }));
    await ingestEngagement(projectId, burst, testDb);
    const { confirmed, flagged } = await confirmPendingEngagement(projectId, testDb);
    expect(confirmed).toBe(0); // all dampened as a burst
    expect(flagged).toBe(4);
    const score = await testDb.query.projectScores.findFirst({
      where: eq(projectScores.projectId, projectId),
    });
    expect(score?.rawR).toBe(0); // nothing counts
  });

  it('combines on-platform support with confirmed social engagement, applying the per-source cap', async () => {
    const { projectId } = await publishedProject();
    await ingestEngagement(projectId, events, testDb);
    await confirmPendingEngagement(projectId, testDb); // facebook confirmed = 4
    const supporter = await createPlatformAdmin('fan@x.com', 'password-1234', testDb);
    await supportProject(supporter, projectId, testDb); // on_platform = 1
    const score = await testDb.query.projectScores.findFirst({
      where: eq(projectScores.projectId, projectId),
    });
    // Two sources: facebook(4) capped to on_platform(1) → R = 1 + 1 = 2 (§4 cap).
    expect(score?.rawR).toBe(2);
  });
});
