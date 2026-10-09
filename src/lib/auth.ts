import { cookies } from 'next/headers';
import { verifySession, SESSION_COOKIE, type SessionPayload } from '@/lib/session';
import { HttpError } from '@/lib/http';

/** Resolve the current session from the request cookie, or null. */
export async function getSession(): Promise<SessionPayload | null> {
  const store = await cookies();
  return verifySession(store.get(SESSION_COOKIE)?.value);
}

export async function requireUser(): Promise<SessionPayload> {
  const session = await getSession();
  if (!session) throw new HttpError(401, 'unauthenticated', 'Sign in required.');
  return session;
}

export async function requirePlatformAdmin(): Promise<SessionPayload> {
  const session = await requireUser();
  if (!session.isPlatformAdmin) throw new HttpError(403, 'forbidden', 'Admin access required.');
  return session;
}
