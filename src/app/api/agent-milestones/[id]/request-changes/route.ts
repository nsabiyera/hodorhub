import { NextResponse } from 'next/server';
import { z } from 'zod';
import { requestChanges } from '@/modules/agent-delivery';
import { requireUser } from '@/lib/auth';
import { errorResponse, readJson } from '@/lib/http';

const schema = z.object({ feedback: z.string().trim().min(1).max(1000) });

// US-11.3 — charity requests changes; the phase loops back to running for a revise cycle.
export async function POST(req: Request, { params }: { params: Promise<{ id: string }> }) {
  try {
    const session = await requireUser();
    const { id } = await params;
    const body = schema.parse(await readJson(req));
    await requestChanges(session.userId, id, body.feedback);
    return NextResponse.json({ ok: true, status: 'changes_requested' });
  } catch (e) {
    return errorResponse(e);
  }
}
