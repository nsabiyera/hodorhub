import { NextResponse } from 'next/server';
import { z } from 'zod';
import { declineComputePledge } from '@/modules/commitments';
import { requireUser } from '@/lib/auth';
import { errorResponse, readJson } from '@/lib/http';

const schema = z.object({ reason: z.string().trim().max(500).optional() });

// US-11.2 — the charity declines a proposed compute pledge.
export async function POST(req: Request, { params }: { params: Promise<{ id: string }> }) {
  try {
    const session = await requireUser();
    const { id } = await params;
    const body = schema.parse(await readJson(req));
    await declineComputePledge(session.userId, id, body.reason);
    return NextResponse.json({ ok: true, status: 'declined' });
  } catch (e) {
    return errorResponse(e);
  }
}
