import { describe, it, expect } from 'vitest';
import { hashPassword, verifyPassword } from './password';

describe('password (argon2id)', () => {
  it('hashes to an argon2id digest, never plaintext', async () => {
    const digest = await hashPassword('correct horse battery staple');
    expect(digest).not.toContain('correct horse');
    expect(digest.startsWith('$argon2id$')).toBe(true);
  });

  it('verifies the correct password and rejects the wrong one', async () => {
    const digest = await hashPassword('s3cret-pw');
    expect(await verifyPassword(digest, 's3cret-pw')).toBe(true);
    expect(await verifyPassword(digest, 'wrong')).toBe(false);
  });

  it('produces distinct digests for the same input (per-hash salt)', async () => {
    expect(await hashPassword('dup')).not.toBe(await hashPassword('dup'));
  });
});
