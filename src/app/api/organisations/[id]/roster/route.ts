import { NextResponse } from 'next/server';
import { getVolunteerRoster } from '@/modules/reporting';
import { requireUser } from '@/lib/auth';
import { errorResponse } from '@/lib/http';

export const dynamic = 'force-dynamic';

/**
 * US-1.5 — the team roster: members, their stated availability and what they
 * are already carrying. 404 for a non-member, 403 for the wrong role; a charity
 * can never reach a corporation's roster.
 */
export async function GET(_req: Request, { params }: { params: Promise<{ id: string }> }) {
  try {
    const session = await requireUser();
    const { id } = await params;
    return NextResponse.json(await getVolunteerRoster(session.userId, id));
  } catch (e) {
    return errorResponse(e);
  }
}
