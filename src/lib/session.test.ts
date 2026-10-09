import { describe, it, expect } from 'vitest';
import { signSession, verifySession, newSession } from './session';

const SECRET = 'x'.repeat(40);

describe('session tokens', () => {
  it('round-trips a signed session', () => {
    const p = newSession('user-1', false, 10_000, 1_000);
    const token = signSession(p, SECRET);
    expect(verifySession(token, SECRET, 2_000)).toEqual(p);
  });

  it('rejects a tampered payload (HMAC mismatch)', () => {
    const token = signSession(newSession('user-1', true, 10_000, 0), SECRET);
    const [body, mac] = token.split('.');
    const forged = Buffer.from(
      JSON.stringify({ userId: 'attacker', isPlatformAdmin: true, exp: 9e15 }),
    ).toString('base64url');
    expect(verifySession(`${forged}.${mac}`, SECRET, 1)).toBeNull();
    expect(verifySession(`${body}.${mac}`, 'wrong-secret-wrong-secret-wrong!!', 1)).toBeNull();
  });

  it('rejects an expired token', () => {
    const token = signSession(newSession('user-1', false, 1_000, 0), SECRET);
    expect(verifySession(token, SECRET, 2_000)).toBeNull(); // now > exp
  });

  it('rejects malformed tokens', () => {
    expect(verifySession(null, SECRET)).toBeNull();
    expect(verifySession('', SECRET)).toBeNull();
    expect(verifySession('nodot', SECRET)).toBeNull();
    expect(verifySession('.onlymac', SECRET)).toBeNull();
  });
});
