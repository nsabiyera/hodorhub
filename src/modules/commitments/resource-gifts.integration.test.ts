import { describe, it, expect } from 'vitest';
import { eq } from 'drizzle-orm';
import { testDb } from '@/test/db';
import { relayOutbox, listForUser } from '@/modules/notifications';
import { resourceGifts, projects, deliveryWorkspaces, digitalResourceNeeds } from '@/db/schema';
import {
  registerCharity,
  registerCorporation,
  approveVerification,
  createPlatformAdmin,
  NotFoundError,
  InvalidStateError,
  NotVerifiedError,
} from '@/modules/identity';
import {
  createDraftProject,
  setResourceNeeds,
  setDigitalResourceNeeds,
  publishProject,
} from '@/modules/projects';
import {
  offerResourceGift,
  listResourceGiftsForProject,
  listResourceGiftsForCorp,
  acceptResourceGift,
  declineResourceGift,
  markResourceGiftProvided,
  confirmResourceGiftReceived,
  withdrawResourceGift,
} from './gifts';

const need = {
  skill: 'Backend',
  role: 'Backend dev',
  kind: 'ongoing' as const,
  quantity: 1,
  hoursPerWeek: 2,
  durationWeeks: 8,
};

async function scenario() {
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
  return { admin, charity, corp, projectId };
}
const gift = (corporationOrgId: string) => ({
  corporationOrgId,
  kind: 'cloud_credits' as const,
  quantity: 500,
  unit: 'USD credits',
  note: 'From our AWS allowance',
});

describe('Commitments — resource gifts (US-5.5)', () => {
  it('offers a gift that awaits charity acceptance', async () => {
    const { charity, corp, projectId } = await scenario();
    const { giftId } = await offerResourceGift(
      corp.userId,
      projectId,
      gift(corp.organisationId),
      testDb,
    );
    const row = await testDb.query.resourceGifts.findFirst({ where: eq(resourceGifts.id, giftId) });
    expect(row?.status).toBe('offered');
    const list = await listResourceGiftsForProject(charity.userId, projectId, testDb);
    expect(list.map((g) => g.id)).toContain(giftId);
  });

  it('charity accepts a gift WITHOUT starting delivery (no workspace, project stays published)', async () => {
    const { charity, corp, projectId } = await scenario();
    const { giftId } = await offerResourceGift(
      corp.userId,
      projectId,
      gift(corp.organisationId),
      testDb,
    );
    await acceptResourceGift(charity.userId, giftId, testDb);
    const row = await testDb.query.resourceGifts.findFirst({ where: eq(resourceGifts.id, giftId) });
    expect(row?.status).toBe('accepted');
    const proj = await testDb.query.projects.findFirst({ where: eq(projects.id, projectId) });
    expect(proj?.status).toBe('published'); // NOT in_delivery
    const ws = await testDb.query.deliveryWorkspaces.findMany({
      where: eq(deliveryWorkspaces.projectId, projectId),
    });
    expect(ws).toHaveLength(0); // gift acceptance is not delivery
  });

  it('allows MANY accepted gifts per project (no single-accept collision)', async () => {
    const { charity, corp, projectId } = await scenario();
    const a = await offerResourceGift(
      corp.userId,
      projectId,
      { ...gift(corp.organisationId), kind: 'cloud_credits' },
      testDb,
    );
    const b = await offerResourceGift(
      corp.userId,
      projectId,
      { ...gift(corp.organisationId), kind: 'llm_budget' },
      testDb,
    );
    await acceptResourceGift(charity.userId, a.giftId, testDb);
    await acceptResourceGift(charity.userId, b.giftId, testDb);
    const accepted = (await listResourceGiftsForProject(charity.userId, projectId, testDb)).filter(
      (g) => g.status === 'accepted',
    );
    expect(accepted).toHaveLength(2);
  });

  it('charity declines with a required reason', async () => {
    const { charity, corp, projectId } = await scenario();
    const { giftId } = await offerResourceGift(
      corp.userId,
      projectId,
      gift(corp.organisationId),
      testDb,
    );
    await expect(declineResourceGift(charity.userId, giftId, '   ', testDb)).rejects.toBeInstanceOf(
      InvalidStateError,
    );
    await declineResourceGift(charity.userId, giftId, 'Already covered by another donor', testDb);
    const row = await testDb.query.resourceGifts.findFirst({ where: eq(resourceGifts.id, giftId) });
    expect(row?.status).toBe('declined');
    expect(row?.reason).toBe('Already covered by another donor');
  });

  it('cannot offer to a non-published project; non-CSR and cross-tenant are refused', async () => {
    const { charity, corp } = await scenario();
    const draft = await createDraftProject(
      charity.userId,
      { charityOrgId: charity.organisationId, title: 'Draft only' },
      testDb,
    );
    await expect(
      offerResourceGift(corp.userId, draft.projectId, gift(corp.organisationId), testDb),
    ).rejects.toBeInstanceOf(InvalidStateError);
    // a charity user is not a CSR manager of the corp
    await expect(
      offerResourceGift(charity.userId, draft.projectId, gift(corp.organisationId), testDb),
    ).rejects.toBeInstanceOf(NotFoundError);
  });

  it('dedupes a duplicate live offer for the same (project, corp, need)', async () => {
    const { charity, corp, projectId } = await scenario();
    // need a real need id to trigger dedupe path
    const { setDigitalResourceNeeds } = await import('@/modules/projects');
    await setDigitalResourceNeeds(charity.userId, projectId, [{ kind: 'cloud_credits' }], testDb);
    const { digitalResourceNeeds } = await import('@/db/schema');
    const [n] = await testDb.query.digitalResourceNeeds.findMany({
      where: eq(digitalResourceNeeds.projectId, projectId),
    });
    const withNeed = { ...gift(corp.organisationId), needId: n!.id };
    await offerResourceGift(corp.userId, projectId, withNeed, testDb);
    await expect(
      offerResourceGift(corp.userId, projectId, withNeed, testDb),
    ).rejects.toBeInstanceOf(InvalidStateError);
  });

  it('refuses an offer from an unverified corporation (US-1.3 gate)', async () => {
    const { projectId } = await scenario();
    const unverified = await registerCorporation(
      {
        email: 'newco@newco.com',
        password: 'a-strong-password',
        companyName: 'NewCo',
        emailDomain: 'newco.com',
      },
      testDb,
    );
    await expect(
      offerResourceGift(unverified.userId, projectId, gift(unverified.organisationId), testDb),
    ).rejects.toBeInstanceOf(NotVerifiedError);
  });
});

describe('Commitments — confirm & withdraw resource gifts (US-6.5)', () => {
  it('provided → received; provided vs received are distinct', async () => {
    const { charity, corp, projectId } = await scenario();
    const { giftId } = await offerResourceGift(
      corp.userId,
      projectId,
      gift(corp.organisationId),
      testDb,
    );
    await acceptResourceGift(charity.userId, giftId, testDb);
    // cannot confirm before provided
    await expect(
      confirmResourceGiftReceived(charity.userId, giftId, testDb),
    ).rejects.toBeInstanceOf(InvalidStateError);
    await markResourceGiftProvided(corp.userId, giftId, testDb);
    let row = await testDb.query.resourceGifts.findFirst({ where: eq(resourceGifts.id, giftId) });
    expect(row?.status).toBe('provided');
    expect(row?.providedAt).not.toBeNull();
    expect(row?.receivedAt).toBeNull(); // not yet confirmed
    await confirmResourceGiftReceived(charity.userId, giftId, testDb);
    row = await testDb.query.resourceGifts.findFirst({ where: eq(resourceGifts.id, giftId) });
    expect(row?.status).toBe('received');
    expect(row?.receivedAt).not.toBeNull();
  });

  it('corp can withdraw before received, not after', async () => {
    const { charity, corp, projectId } = await scenario();
    const { giftId } = await offerResourceGift(
      corp.userId,
      projectId,
      gift(corp.organisationId),
      testDb,
    );
    await withdrawResourceGift(corp.userId, giftId, 'Budget reallocated', testDb);
    const row = await testDb.query.resourceGifts.findFirst({ where: eq(resourceGifts.id, giftId) });
    expect(row?.status).toBe('withdrawn');

    const second = await offerResourceGift(
      corp.userId,
      projectId,
      { ...gift(corp.organisationId), kind: 'domains' },
      testDb,
    );
    await acceptResourceGift(charity.userId, second.giftId, testDb);
    await markResourceGiftProvided(corp.userId, second.giftId, testDb);
    await confirmResourceGiftReceived(charity.userId, second.giftId, testDb);
    await expect(
      withdrawResourceGift(corp.userId, second.giftId, 'too late', testDb),
    ).rejects.toBeInstanceOf(InvalidStateError);
  });
});

describe('Commitments — resource gifts survive need edits (regression)', () => {
  it('editing digital resource needs after a gift references one nulls need_id instead of throwing', async () => {
    const { charity, corp, projectId } = await scenario();
    await setDigitalResourceNeeds(charity.userId, projectId, [{ kind: 'cloud_credits' }], testDb);
    const [need] = await testDb.query.digitalResourceNeeds.findMany({
      where: eq(digitalResourceNeeds.projectId, projectId),
    });
    const { giftId } = await offerResourceGift(
      corp.userId,
      projectId,
      { ...gift(corp.organisationId), needId: need!.id },
      testDb,
    );

    // Replace-all edit of the needs must not be blocked by the FK the gift holds.
    await expect(
      setDigitalResourceNeeds(charity.userId, projectId, [{ kind: 'llm_budget' }], testDb),
    ).resolves.toBeUndefined();

    const row = await testDb.query.resourceGifts.findFirst({ where: eq(resourceGifts.id, giftId) });
    expect(row).toBeDefined();
    expect(row?.needId).toBeNull();
  });
});

describe('Notifications — resource gifts (US-8.1)', () => {
  it('an offered gift notifies the charity owner; acceptance notifies the CSR manager', async () => {
    const { charity, corp, projectId } = await scenario();
    const { giftId } = await offerResourceGift(
      corp.userId,
      projectId,
      gift(corp.organisationId),
      testDb,
    );
    await relayOutbox(testDb);
    const charityNotes = await listForUser(charity.userId, testDb);
    expect(charityNotes.some((n) => n.type === 'resource_gift.offered')).toBe(true);

    await acceptResourceGift(charity.userId, giftId, testDb);
    await relayOutbox(testDb);
    const corpNotes = await listForUser(corp.userId, testDb);
    expect(corpNotes.some((n) => n.type === 'resource_gift.accepted')).toBe(true);
  });
});

describe('Commitments — listResourceGiftsForCorp', () => {
  it('returns only the acting corp’s gifts on the project', async () => {
    const { charity, corp, projectId } = await scenario();
    const admin2 = await createPlatformAdmin('admin2@hh.com', 'admin-password-1', testDb);
    const corp2 = await registerCorporation(
      {
        email: 'dana@beta.com',
        password: 'a-strong-password',
        companyName: 'Beta',
        emailDomain: 'beta.com',
      },
      testDb,
    );
    await approveVerification(corp2.verificationRequestId, admin2, testDb);

    await offerResourceGift(corp.userId, projectId, gift(corp.organisationId), testDb);
    await offerResourceGift(
      corp.userId,
      projectId,
      { ...gift(corp.organisationId), kind: 'llm_budget' },
      testDb,
    );
    await offerResourceGift(corp2.userId, projectId, gift(corp2.organisationId), testDb);

    const mine = await listResourceGiftsForCorp(
      corp.userId,
      projectId,
      corp.organisationId,
      testDb,
    );
    expect(mine).toHaveLength(2);
    expect(mine.every((g) => g.corporationOrgId === corp.organisationId)).toBe(true);
    // charity user is not a csr_manager of the corp
    await expect(
      listResourceGiftsForCorp(charity.userId, projectId, corp.organisationId, testDb),
    ).rejects.toBeInstanceOf(NotFoundError);
  });
});
