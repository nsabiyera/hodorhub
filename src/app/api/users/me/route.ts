import { NextResponse } from 'next/server';
import { eraseUser } from '@/modules/privacy';
import { requireUser } from '@/lib/auth';
import { SESSION_COOKIE } from '@/lib/session';
import { errorResponse } from '@/lib/http';

// GDPR right-to-erasure — a user erases their own account.
export async function DELETE() {
  try {
    const session = await requireUser();
    await eraseUser(session.userId);
    const res = NextResponse.json({ ok: true, erased: true });
    res.cookies.set(SESSION_COOKIE, '', { httpOnly: true, path: '/', maxAge: 0 });
    return res;
  } catch (e) {
    return errorResponse(e);
  }
}
