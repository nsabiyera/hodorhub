import { createHmac, timingSafeEqual } from 'node:crypto';

/**
 * Stateless signed session token: `base64url(payloadJSON).base64url(hmacSHA256)`.
 * HMAC keyed by SESSION_SECRET. No session table needed at MVP (ADR 0001) — this
 * scales horizontally on Cloud Run without shared state (ADR 0002).
 *
 * The secret is a parameter (default: SESSION_SECRET) so this module is pure and
 * unit-testable without env side effects.
 */
export const SESSION_COOKIE = 'hh_session';
const DEFAULT_TTL_MS = 1000 * 60 * 60 * 24 * 7; // 7 days

export interface SessionPayload {
  userId: string;
  isPlatformAdmin: boolean;
  exp: number; // epoch ms
}

function b64url(buf: Buffer): string {
  return buf.toString('base64url');
}

function secretFromEnv(): string {
  const s = process.env.SESSION_SECRET;
  if (!s || s.length < 32) throw new Error('SESSION_SECRET is missing or too short');
  return s;
}

export function signSession(payload: SessionPayload, secret: string = secretFromEnv()): string {
  const body = b64url(Buffer.from(JSON.stringify(payload)));
  const mac = b64url(createHmac('sha256', secret).update(body).digest()); // lgtm [js/insufficient-password-hash] HMAC signs session data; it is not used to hash or store passwords.
  return `${body}.${mac}`;
}

/** Returns the payload if the token is authentic and unexpired, else null. */
export function verifySession(
  token: string | undefined | null,
  secret: string = secretFromEnv(),
  now: number = Date.now(),
): SessionPayload | null {
  if (!token) return null;
  const dot = token.indexOf('.');
  if (dot <= 0) return null;
  const body = token.slice(0, dot);
  const mac = token.slice(dot + 1);

  const expected = b64url(createHmac('sha256', secret).update(body).digest());
  const a = Buffer.from(mac);
  const b = Buffer.from(expected);
  if (a.length !== b.length || !timingSafeEqual(a, b)) return null;

  try {
    const payload = JSON.parse(Buffer.from(body, 'base64url').toString('utf8')) as SessionPayload;
    if (typeof payload.exp !== 'number' || payload.exp < now) return null;
    return payload;
  } catch {
    return null;
  }
}

export function newSession(
  userId: string,
  isPlatformAdmin: boolean,
  ttlMs: number = DEFAULT_TTL_MS,
  now: number = Date.now(),
): SessionPayload {
  return { userId, isPlatformAdmin, exp: now + ttlMs };
}
