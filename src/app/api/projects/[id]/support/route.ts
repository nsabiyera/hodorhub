import { NextResponse } from 'next/server';
import { supportProject, unsupportProject, getSupportInfo } from '@/modules/engagement';
import { getSession, requireUser } from '@/lib/auth';
import { errorResponse, clientIp, enforceLimit } from '@/lib/http';
import { createRateLimiter } from '@/lib/ratelimit';

export const dynamic = 'force-dynamic';

// 30 support toggles / minute / IP — anti-gaming friction (H1).
const limiter = createRateLimiter(30, 60_000);

// US-3.3 — support / undo support / read support info for a project.
export async function POST(req: Request, { params }: { params: Promise<{ id: string }> }) {
  try {
    enforceLimit(limiter(clientIp(req)));
    const session = await requireUser();
    const { id } = await params;
    const { supportCount } = await supportProject(session.userId, id);
    return NextResponse.json({ supported: true, supportCount });
  } catch (e) {
    return errorResponse(e);
  }
}

export async function DELETE(_req: Request, { params }: { params: Promise<{ id: string }> }) {
  try {
    const session = await requireUser();
    const { id } = await params;
    const { supportCount } = await unsupportProject(session.userId, id);
    return NextResponse.json({ supported: false, supportCount });
  } catch (e) {
    return errorResponse(e);
  }
}

export async function GET(_req: Request, { params }: { params: Promise<{ id: string }> }) {
  try {
    const { id } = await params;
    const session = await getSession();
    return NextResponse.json(await getSupportInfo(id, session?.userId ?? null));
  } catch (e) {
    return errorResponse(e);
  }
}
