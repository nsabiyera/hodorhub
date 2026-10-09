import { NextResponse } from 'next/server';
import { SESSION_COOKIE } from '@/lib/session';

// Clears the session cookie. (Stateless sessions have no server-side revocation —
// short TTL + this cookie clear; a revocation list is tracked tech-debt.)
export async function POST() {
  const res = NextResponse.json({ ok: true });
  res.cookies.set(SESSION_COOKIE, '', { httpOnly: true, path: '/', maxAge: 0 });
  return res;
}
