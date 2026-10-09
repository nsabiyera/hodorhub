import { NextResponse } from 'next/server';
import { z } from 'zod';
import { rejectMilestone } from '@/modules/agent-delivery';
import { requireUser } from '@/lib/auth';
import { errorResponse, readJson } from '@/lib/http';

const schema = z.object({ reason: z.string().trim().min(1).max(1000) });

// US-11.3 — charity rejects; the run stops.
export async function POST(req: Request, { params }: { params: Promise<{ id: string }> }) {
  try {
    const session = await requireUser();
    const { id } = await params;
    const body = schema.parse(await readJson(req));
    await rejectMilestone(session.userId, id, body.reason);
    return NextResponse.json({ ok: true, status: 'rejected' });
  } catch (e) {
    return errorResponse(e);
  }
}
