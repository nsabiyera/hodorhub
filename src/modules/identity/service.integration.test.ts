import { describe, it, expect } from 'vitest';
import { eq } from 'drizzle-orm';
import { testDb } from '@/test/db';
import { relayOutbox } from '@/modules/notifications';
import { organisations, memberships, notifications } from '@/db/schema';
import {
  registerCharity,
  registerCorporation,
  listPendingVerifications,
  approveVerification,
  rejectVerification,
  assertOrganisationVerified,
  authenticate,
  createPlatformAdmin,
} from './service';
import {
  EmailInUseError,
  InvalidWorkEmailError,
  InvalidCredentialsError,
  InvalidStateError,
  NotVerifiedError,
} from './errors';

const charity = {
  email: 'petra@goodcause.org',
  password: 'a-strong-password',
  charityName: 'Good Cause',
  regNumber: 'CH-12345',
};
const corp = {
  email: 'carlos@acme.com',
  password: 'another-strong-pw',
  companyName: 'Acme Ltd',
  emailDomain: 'acme.com',
};

describe('Identity & Org — registration (US-1.1, US-1.2)', () => {
  it('registers a charity in PENDING state with an owner membership and an event', async () => {
    const res = await registerCharity(charity, testDb);

    const org = await testDb.query.organisations.findFirst({
      where: eq(organisations.id, res.organisationId),
    });
    expect(org?.type).toBe('charity');
    expect(org?.status).toBe('pending'); // US-1.1: pending until verified

    const member = await testDb.query.memberships.findFirst({
      where: eq(memberships.organisationId, res.organisationId),
    });
    expect(member?.userId).toBe(res.userId);
    expect(member?.role).toBe('charity_owner');

    const events = await testDb.query.outbox.findMany();
    expect(events.map((e) => e.eventType)).toContain('CharityRegistered');
  });

  it('registers a corporation with a csr_manager and pending status', async () => {
    const res = await registerCorporation(corp, testDb);
    const org = await testDb.query.organisations.findFirst({
      where: eq(organisations.id, res.organisationId),
    });
    expect(org?.type).toBe('corporation');
    expect(org?.status).toBe('pending');
    const member = await testDb.query.memberships.findFirst({
      where: eq(memberships.organisationId, res.organisationId),
    });
    expect(member?.role).toBe('csr_manager');
  });

  it('rejects a corporation whose email is not on the work domain (US-1.2)', async () => {
    await expect(
      registerCorporation({ ...corp, email: 'carlos@gmail.com' }, testDb),
    ).rejects.toBeInstanceOf(InvalidWorkEmailError);
    // nothing should have been created
    expect(await testDb.query.organisations.findMany()).toHaveLength(0);
  });

  it('rejects duplicate emails and leaves no partial org (transactional)', async () => {
    await registerCharity(charity, testDb);
    await expect(registerCharity(charity, testDb)).rejects.toBeInstanceOf(EmailInUseError);
    expect(await testDb.query.organisations.findMany()).toHaveLength(1);
  });
});

describe('Identity & Org — verification (US-1.3)', () => {
  it('lists pending requests, approves one → org verified + owner notified', async () => {
    const admin = await createPlatformAdmin('alex@hodorhub.com', 'admin-password-1', testDb);
    const res = await registerCharity(charity, testDb);

    const pending = await listPendingVerifications(testDb);
    expect(pending.map((p) => p.id)).toContain(res.verificationRequestId);

    await approveVerification(res.verificationRequestId, admin, testDb);

    const org = await testDb.query.organisations.findFirst({
      where: eq(organisations.id, res.organisationId),
    });
    expect(org?.status).toBe('verified');

    await relayOutbox(testDb); // event → notification
    const notes = await testDb.query.notifications.findMany({
      where: eq(notifications.userId, res.userId),
    });
    expect(notes.some((n) => n.type === 'organisation.verified')).toBe(true);

    const events = (await testDb.query.outbox.findMany()).map((e) => e.eventType);
    expect(events).toContain('OrganisationVerified');
    // and the request is no longer pending
    expect((await listPendingVerifications(testDb)).length).toBe(0);
  });

  it('rejects with a reason → org rejected, reason recorded, owner notified', async () => {
    const admin = await createPlatformAdmin('alex@hodorhub.com', 'admin-password-1', testDb);
    const res = await registerCorporation(corp, testDb);

    await rejectVerification(
      res.verificationRequestId,
      admin,
      'Could not confirm company records',
      testDb,
    );

    const org = await testDb.query.organisations.findFirst({
      where: eq(organisations.id, res.organisationId),
    });
    expect(org?.status).toBe('rejected');

    await relayOutbox(testDb); // event → notification
    const note = (
      await testDb.query.notifications.findMany({ where: eq(notifications.userId, res.userId) })
    ).find((n) => n.type === 'organisation.rejected');
    expect((note?.payload as { reason?: string })?.reason).toMatch(/company records/);
  });

  it('requires a reason to reject', async () => {
    const admin = await createPlatformAdmin('alex@hodorhub.com', 'admin-password-1', testDb);
    const res = await registerCharity(charity, testDb);
    await expect(
      rejectVerification(res.verificationRequestId, admin, '   ', testDb),
    ).rejects.toBeInstanceOf(InvalidStateError);
  });

  it('cannot decide an already-decided request', async () => {
    const admin = await createPlatformAdmin('alex@hodorhub.com', 'admin-password-1', testDb);
    const res = await registerCharity(charity, testDb);
    await approveVerification(res.verificationRequestId, admin, testDb);
    await expect(
      approveVerification(res.verificationRequestId, admin, testDb),
    ).rejects.toBeInstanceOf(InvalidStateError);
  });
});

describe('Identity & Org — invariants & auth', () => {
  it('assertOrganisationVerified blocks unverified, allows verified (US-1.1 publish guard)', async () => {
    const admin = await createPlatformAdmin('alex@hodorhub.com', 'admin-password-1', testDb);
    const res = await registerCharity(charity, testDb);

    await expect(assertOrganisationVerified(res.organisationId, testDb)).rejects.toBeInstanceOf(
      NotVerifiedError,
    );

    await approveVerification(res.verificationRequestId, admin, testDb);
    await expect(assertOrganisationVerified(res.organisationId, testDb)).resolves.toBeUndefined();
  });

  it('authenticates valid credentials and rejects wrong password / unknown user', async () => {
    await registerCharity(charity, testDb);
    await expect(authenticate(charity.email, charity.password, testDb)).resolves.toMatchObject({
      isPlatformAdmin: false,
    });
    await expect(authenticate(charity.email, 'wrong', testDb)).rejects.toBeInstanceOf(
      InvalidCredentialsError,
    );
    await expect(authenticate('nobody@nowhere.com', 'whatever', testDb)).rejects.toBeInstanceOf(
      InvalidCredentialsError,
    );
  });
});
