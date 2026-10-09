import { NextResponse } from 'next/server';
import { achieveMilestone } from '@/modules/delivery';
import { requireUser } from '@/lib/auth';
import { errorResponse } from '@/lib/http';

// US-6.3 — the charity confirms a milestone. Distinct from
// /api/agent-milestones/[id]/approve, which gates an Epic 11 agent run phase.
export async function POST(_req: Request, { params }: { params: Promise<{ id: string }> }) {
  try {
    const session = await requireUser();
    const { id } = await params;
    await achieveMilestone(session.userId, id);
    return NextResponse.json({ ok: true });
  } catch (e) {
    return errorResponse(e);
  }
}
