import { describe, it, expect } from 'vitest';
import { testDb } from '@/test/db';
import { plans, subscriptions } from '@/db/schema';
import {
  inviteMember,
  listMembers,
  removeMember,
  countMembers,
  InvalidStateError,
  ForbiddenError,
  NotFoundError,
} from '@/modules/identity';
import { twoOrgs } from '@/test/agent-delivery-fixtures';
import { getSeatUsage, assertSeatAvailable } from './service';
import { SeatLimitReachedError } from './errors';

async function subscribe(organisationId: string, code: string, name: string) {
  const [plan] = await testDb.insert(plans).values({ code, name }).returning({ id: plans.id });
  await testDb.insert(subscriptions).values({ organisationId, planId: plan!.id, status: 'active' });
}

/** Fill an organisation up to exactly its seat limit. */
async function fillSeats(corp: { userId: string; organisationId: string }, upTo: number) {
  let used = await countMembers(corp.organisationId, testDb);
  let i = 0;
  while (used < upTo) {
    await inviteMember(corp.userId, corp.organisationId, `seat${i}@acme.com`, 'volunteer', testDb);
    used = await countMembers(corp.organisationId, testDb);
    i += 1;
  }
}

describe('seat usage and limits (US-10.7)', () => {
  it('reports seats used against the Starter limit', async () => {
    const { corp } = await twoOrgs();

    const usage = await getSeatUsage(corp.organisationId, testDb);

    expect(usage.used).toBe(1); // the founding CSR manager
    expect(usage.seatLimit).toBe(5);
    expect(usage.remaining).toBe(4);
    expect(usage.planName).toBe('Starter');
  });

  it('counts an invited member who has never signed in — the seat is the access', async () => {
    const { corp } = await twoOrgs();
    await inviteMember(corp.userId, corp.organisationId, 'dana@acme.com', 'volunteer', testDb);

    expect((await getSeatUsage(corp.organisationId, testDb)).used).toBe(2);
  });

  it('refuses a new member once every seat is taken, naming the plan with more', async () => {
    const { corp } = await twoOrgs();
    await fillSeats(corp, 5);

    await expect(assertSeatAvailable(corp.organisationId, testDb)).rejects.toBeInstanceOf(
      SeatLimitReachedError,
    );
    try {
      await assertSeatAvailable(corp.organisationId, testDb);
      expect.unreachable();
    } catch (e) {
      const err = e as SeatLimitReachedError;
      expect(err.code).toBe('seat_limit_reached');
      expect(err.seatLimit).toBe(5);
      expect(err.nextPlanName).toBe('Team');
    }
  });

  it('a bigger plan raises the limit', async () => {
    const { corp } = await twoOrgs();
    await subscribe(corp.organisationId, 'team', 'Team');
    await fillSeats(corp, 6);

    const usage = await getSeatUsage(corp.organisationId, testDb);
    expect(usage.seatLimit).toBe(50);
    await expect(assertSeatAvailable(corp.organisationId, testDb)).resolves.toBeUndefined();
  });

  it('Enterprise is unlimited, reported as a null limit rather than a sentinel', async () => {
    const { corp } = await twoOrgs();
    await subscribe(corp.organisationId, 'enterprise', 'Enterprise');

    const usage = await getSeatUsage(corp.organisationId, testDb);
    expect(usage.seatLimit).toBeNull();
    expect(usage.remaining).toBeNull();
    await expect(assertSeatAvailable(corp.organisationId, testDb)).resolves.toBeUndefined();
  });

  it('a charity has no seat limit at all (US-10.3)', async () => {
    const { charity } = await twoOrgs();

    const usage = await getSeatUsage(charity.organisationId, testDb);
    expect(usage.seatLimit).toBeNull();
    await expect(assertSeatAvailable(charity.organisationId, testDb)).resolves.toBeUndefined();
  });

  it('freeing a seat lets a new member in again', async () => {
    const { corp } = await twoOrgs();
    await fillSeats(corp, 5);
    await expect(assertSeatAvailable(corp.organisationId, testDb)).rejects.toBeInstanceOf(
      SeatLimitReachedError,
    );

    const members = await listMembers(corp.userId, corp.organisationId, testDb);
    const volunteer = members.find((m) => m.role === 'volunteer')!;
    await removeMember(corp.userId, corp.organisationId, volunteer.userId, testDb);

    expect((await getSeatUsage(corp.organisationId, testDb)).remaining).toBe(1);
    await expect(assertSeatAvailable(corp.organisationId, testDb)).resolves.toBeUndefined();
  });
});

describe('removing members (US-10.7)', () => {
  it('refuses to remove the last administrator', async () => {
    const { corp } = await twoOrgs();

    // Removing the only csr_manager would leave an org nobody can ever invite into.
    await expect(
      removeMember(corp.userId, corp.organisationId, corp.userId, testDb),
    ).rejects.toBeInstanceOf(InvalidStateError);
    expect(await countMembers(corp.organisationId, testDb)).toBe(1);
  });

  it('allows removing an administrator while another remains', async () => {
    const { corp } = await twoOrgs();
    const second = await inviteMember(
      corp.userId,
      corp.organisationId,
      'boss2@acme.com',
      'csr_manager',
      testDb,
    );

    await removeMember(corp.userId, corp.organisationId, second.userId, testDb);

    expect(await countMembers(corp.organisationId, testDb)).toBe(1);
  });

  it('refuses a volunteer trying to remove anyone', async () => {
    const { corp } = await twoOrgs();
    const volunteer = await inviteMember(
      corp.userId,
      corp.organisationId,
      'dana@acme.com',
      'volunteer',
      testDb,
    );

    await expect(
      removeMember(volunteer.userId, corp.organisationId, corp.userId, testDb),
    ).rejects.toBeInstanceOf(ForbiddenError);
  });

  it('refuses someone outside the organisation, without leaking that it exists', async () => {
    const { charity, corp } = await twoOrgs();

    await expect(
      removeMember(charity.userId, corp.organisationId, corp.userId, testDb),
    ).rejects.toBeInstanceOf(NotFoundError);
  });

  it('refuses removing someone who is not a member', async () => {
    const { charity, corp } = await twoOrgs();

    await expect(
      removeMember(corp.userId, corp.organisationId, charity.userId, testDb),
    ).rejects.toBeInstanceOf(NotFoundError);
  });
});
