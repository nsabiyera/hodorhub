import { createHash, randomBytes } from 'node:crypto';
import { and, eq } from 'drizzle-orm';
import { z } from 'zod';
import { db as defaultDb } from '@/db';
import { authTokens, users } from '@/db/schema';
import { hashPassword } from '@/lib/password';
import { InvalidStateError } from './errors';

/**
 * Email-verification & password-reset tokens. The raw token is returned once (to
 * email); only its SHA-256 hash is stored, so a DB leak can't be used to verify
 * emails or reset passwords. Tokens are single-use and time-limited.
 */
type Db = typeof defaultDb;
type Kind = 'email_verify' | 'password_reset';

const TTL_MS: Record<Kind, number> = {
  email_verify: 1000 * 60 * 60 * 24, // 24h
  password_reset: 1000 * 60 * 30, // 30m
};

function hashToken(raw: string): string {
  // codeql[js/insufficient-password-hash] These are 256-bit CSPRNG bearer tokens, not human passwords.
  // A fast hash is appropriate for this entropy and prevents a database leak from exposing usable tokens.
  return createHash('sha256').update(raw).digest('hex');
}

async function issueToken(db: Db, userId: string, kind: Kind): Promise<string> {
  const raw = randomBytes(32).toString('base64url');
  await db.insert(authTokens).values({
    userId,
    kind,
    tokenHash: hashToken(raw),
    expiresAt: new Date(Date.now() + TTL_MS[kind]),
  });
  return raw;
}

async function consumeToken(db: Db, rawToken: string, kind: Kind): Promise<string> {
  return db.transaction(async (tx) => {
    const tok = await tx.query.authTokens.findFirst({
      where: and(eq(authTokens.tokenHash, hashToken(rawToken)), eq(authTokens.kind, kind)),
    });
    if (!tok || tok.usedAt || tok.expiresAt.getTime() < Date.now()) {
      throw new InvalidStateError('Invalid or expired token.');
    }
    await tx.update(authTokens).set({ usedAt: new Date() }).where(eq(authTokens.id, tok.id));
    return tok.userId;
  });
}

/** Create an email-verification token for a user (caller emails the link). */
export function requestEmailVerification(userId: string, db: Db = defaultDb): Promise<string> {
  return issueToken(db, userId, 'email_verify');
}

/** Consume an email-verification token → mark the user's email verified. */
export async function verifyEmail(rawToken: string, db: Db = defaultDb): Promise<void> {
  const userId = await consumeToken(db, rawToken, 'email_verify');
  await db.update(users).set({ emailVerifiedAt: new Date() }).where(eq(users.id, userId));
}

/**
 * Create a password-reset token. Returns null for an unknown email so the caller
 * can respond identically either way (anti-enumeration).
 */
export async function requestPasswordReset(
  email: string,
  db: Db = defaultDb,
): Promise<{ userId: string; token: string } | null> {
  const user = await db.query.users.findFirst({ where: eq(users.email, email.toLowerCase()) });
  if (!user) return null;
  return { userId: user.id, token: await issueToken(db, user.id, 'password_reset') };
}

/** Consume a password-reset token → set a new password. */
export async function resetPassword(
  rawToken: string,
  newPassword: string,
  db: Db = defaultDb,
): Promise<void> {
  z.string().min(10).max(200).parse(newPassword);
  const userId = await consumeToken(db, rawToken, 'password_reset');
  await db
    .update(users)
    .set({ passwordHash: await hashPassword(newPassword) })
    .where(eq(users.id, userId));
}
