import { NextResponse } from 'next/server';
import { postMessage, messageSchema } from '@/modules/messaging';
import { requireUser } from '@/lib/auth';
import { readJson, errorResponse, enforceLimit } from '@/lib/http';
import { createRateLimiter } from '@/lib/ratelimit';

export const dynamic = 'force-dynamic';

/**
 * 10 messages / minute / user. An unmetered write that notifies someone else is
 * a spam vector.
 *
 * Keyed on the user, not the IP: the caller is authenticated, so the user id is
 * both stronger and unspoofable — and our users are corporate employees behind
 * one NAT, so an IP key would rate-limit a whole CSR team because one person
 * types fast. Not keyed per thread either, or one account gets 10 x threads.
 *
 * Per-instance only (TECH_DEBT H1): with N web instances the real ceiling is
 * 10N/min.
 */
const limiter = createRateLimiter(10, 60_000);

/**
 * US-8.3 — post to the conversation for (this project, this corporation),
 * creating the thread on first use.
 *
 * Addressed by project + corporation rather than by thread id: that pair IS the
 * thread's identity, it gives exactly one write path to rate-limit and audit,
 * and it makes an empty thread impossible.
 */
export async function POST(req: Request, { params }: { params: Promise<{ id: string }> }) {
  try {
    const session = await requireUser();
    enforceLimit(limiter(session.userId));
    const { id } = await params;
    const input = messageSchema.parse(await readJson(req));
    const result = await postMessage(session.userId, id, input);
    return NextResponse.json(result, { status: 201 });
  } catch (e) {
    return errorResponse(e);
  }
}
