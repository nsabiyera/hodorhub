import { describe, it, expect } from 'vitest';
import { randomBytes } from 'node:crypto';
import { encryptSecret, decryptSecret } from './crypto';

const KEY = randomBytes(32);

describe('crypto (AES-256-GCM)', () => {
  it('round-trips plaintext, including unicode and empty string', () => {
    for (const s of ['hello', '', 'ünïcödé 🔐 tokens', 'a'.repeat(1000)]) {
      expect(decryptSecret(encryptSecret(s, KEY), KEY)).toBe(s);
    }
  });

  it('produces a different ciphertext each time (random IV)', () => {
    expect(encryptSecret('same', KEY)).not.toBe(encryptSecret('same', KEY));
  });

  it('rejects tampered ciphertext (GCM auth tag)', () => {
    const buf = Buffer.from(encryptSecret('secret', KEY), 'base64');
    buf[buf.length - 1]! ^= 0x01; // flip a bit in the ciphertext
    expect(() => decryptSecret(buf.toString('base64'), KEY)).toThrow();
  });

  it('rejects decryption with the wrong key', () => {
    const payload = encryptSecret('secret', KEY);
    expect(() => decryptSecret(payload, randomBytes(32))).toThrow();
  });

  it('rejects a truncated payload', () => {
    expect(() => decryptSecret('AAAA', KEY)).toThrow(/too short/);
  });

  it('uses APP_ENCRYPTION_KEY by default when no key is passed', () => {
    const prev = process.env.APP_ENCRYPTION_KEY;
    process.env.APP_ENCRYPTION_KEY = randomBytes(32).toString('base64');
    try {
      expect(decryptSecret(encryptSecret('viaEnv'))).toBe('viaEnv');
    } finally {
      process.env.APP_ENCRYPTION_KEY = prev;
    }
  });
});
