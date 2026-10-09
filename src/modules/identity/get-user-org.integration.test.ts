import { describe, it, expect } from 'vitest';
import { testDb } from '@/test/db';
import {
  registerCharity,
  registerCorporation,
  approveVerification,
  createPlatformAdmin,
  getUserOrg,
} from './index';

describe('Identity — getUserOrg', () => {
  it('resolves a charity owner membership + org', async () => {
    const c = await registerCharity(
      {
        email: 'petra@goodcause.org',
        password: 'a-strong-password',
        charityName: 'Good Cause',
        regNumber: 'CH-1',
      },
      testDb,
    );
    const org = await getUserOrg(c.userId, testDb);
    expect(org).toEqual({
      organisationId: c.organisationId,
      role: 'charity_owner',
      orgType: 'charity',
      status: 'pending',
    });
  });

  it('reflects verification status for a corporation csr_manager', async () => {
    const admin = await createPlatformAdmin('admin@hh.com', 'admin-password-1', testDb);
    const corp = await registerCorporation(
      {
        email: 'carlos@acme.com',
        password: 'a-strong-password',
        companyName: 'Acme',
        emailDomain: 'acme.com',
      },
      testDb,
    );
    let org = await getUserOrg(corp.userId, testDb);
    expect(org).toMatchObject({ role: 'csr_manager', orgType: 'corporation', status: 'pending' });
    await approveVerification(corp.verificationRequestId, admin, testDb);
    org = await getUserOrg(corp.userId, testDb);
    expect(org?.status).toBe('verified');
  });

  it('returns null for a user with no membership (e.g. platform admin)', async () => {
    const admin = await createPlatformAdmin('solo@hh.com', 'admin-password-1', testDb);
    expect(await getUserOrg(admin, testDb)).toBeNull();
  });
});
