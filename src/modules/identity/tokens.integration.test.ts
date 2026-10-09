import { describe, it, expect } from 'vitest';
import { eq } from 'drizzle-orm';
import { testDb } from '@/test/db';
import { users } from '@/db/schema';
import { registerCharity } from './service';
import {
  requestEmailVerification,
  verifyEmail,
  requestPasswordReset,
  resetPassword,
  authenticate,
} from './index';
import { InvalidStateError, InvalidCredentialsError } from './errors';

async function newUser(email = 'petra@goodcause.org') {
  const r = await registerCharity(
    { email, password: 'a-strong-password', charityName: 'Good Cause', regNumber: 'CH-1' },
    testDb,
  );
  return r.userId;
}

describe('Email verification (US-1.8)', () => {
  it('verifies an email with a valid token, once', async () => {
    const userId = await newUser();
    const token = await requestEmailVerification(userId, testDb);
    let user = await testDb.query.users.findFirst({ where: eq(users.id, userId) });
    expect(user?.emailVerifiedAt).toBeNull();

    await verifyEmail(token, testDb);
    user = await testDb.query.users.findFirst({ where: eq(users.id, userId) });
    expect(user?.emailVerifiedAt).not.toBeNull();

    // single-use
    await expect(verifyEmail(token, testDb)).rejects.toBeInstanceOf(InvalidStateError);
  });

  it('rejects an unknown token', async () => {
    await expect(verifyEmail('not-a-real-token', testDb)).rejects.toBeInstanceOf(InvalidStateError);
  });
});

describe('Password reset (US-1.9)', () => {
  it('resets the password with a valid token; old password stops working', async () => {
    const userId = await newUser();
    const req = await requestPasswordReset('petra@goodcause.org', testDb);
    expect(req?.userId).toBe(userId);

    await resetPassword(req!.token, 'a-brand-new-password', testDb);
    await expect(
      authenticate('petra@goodcause.org', 'a-brand-new-password', testDb),
    ).resolves.toMatchObject({ userId });
    await expect(
      authenticate('petra@goodcause.org', 'a-strong-password', testDb),
    ).rejects.toBeInstanceOf(InvalidCredentialsError);
  });

  it('is anti-enumeration: unknown email yields null (caller responds 200 anyway)', async () => {
    expect(await requestPasswordReset('nobody@nowhere.com', testDb)).toBeNull();
  });

  it('reset token is single-use', async () => {
    await newUser();
    const req = await requestPasswordReset('petra@goodcause.org', testDb);
    await resetPassword(req!.token, 'first-new-password', testDb);
    await expect(resetPassword(req!.token, 'second-new-password', testDb)).rejects.toBeInstanceOf(
      InvalidStateError,
    );
  });
});
