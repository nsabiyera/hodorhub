import { NextResponse } from 'next/server';
import { acceptComputePledge } from '@/modules/commitments';
import { requireUser } from '@/lib/auth';
import { errorResponse } from '@/lib/http';

// US-11.2 — the charity accepts a compute pledge; a run is authorised + escrowed.
export async function POST(_req: Request, { params }: { params: Promise<{ id: string }> }) {
  try {
    const session = await requireUser();
    const { id } = await params;
    const { runId } = await acceptComputePledge(session.userId, id);
    return NextResponse.json({ ok: true, runId });
  } catch (e) {
    return errorResponse(e);
  }
}
