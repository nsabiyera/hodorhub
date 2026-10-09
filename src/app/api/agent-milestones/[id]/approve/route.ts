import { NextResponse } from 'next/server';
import { approveMilestone } from '@/modules/agent-delivery';
import { requireUser } from '@/lib/auth';
import { errorResponse } from '@/lib/http';

// US-11.3 — charity approves a phase; the next phase begins (or the run completes).
export async function POST(_req: Request, { params }: { params: Promise<{ id: string }> }) {
  try {
    const session = await requireUser();
    const { id } = await params;
    await approveMilestone(session.userId, id);
    return NextResponse.json({ ok: true, status: 'approved' });
  } catch (e) {
    return errorResponse(e);
  }
}
