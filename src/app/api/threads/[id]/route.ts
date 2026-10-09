import { NextResponse } from 'next/server';
import { getThread } from '@/modules/messaging';
import { requireUser } from '@/lib/auth';
import { errorResponse } from '@/lib/http';

export const dynamic = 'force-dynamic';

/**
 * US-8.3 — one thread's messages, oldest-first, paginated backwards.
 *
 * An unknown thread, a non-participant and a platform admin all receive the
 * same 404: the response must not distinguish "no such conversation" from "not
 * yours", or it becomes an existence oracle.
 */
export async function GET(req: Request, { params }: { params: Promise<{ id: string }> }) {
  try {
    const session = await requireUser();
    const { id } = await params;
    const beforeParam = new URL(req.url).searchParams.get('before');
    // A nonsense cursor is rejected by the domain (400 `invalid_cursor`), not
    // by a hand-rolled check here: `seq` is a bigint and a fractional or
    // absurd value reaches Postgres as invalid text, which would be a 500.
    const before = beforeParam === null ? undefined : Number(beforeParam);
    return NextResponse.json(await getThread(session.userId, id, { before }));
  } catch (e) {
    return errorResponse(e);
  }
}
