import { NextResponse } from 'next/server';
import { z } from 'zod';
import { declinePledge } from '@/modules/commitments';
import { requireUser } from '@/lib/auth';
import { readJson, errorResponse } from '@/lib/http';

const schema = z.object({ reason: z.string().min(1).max(1000) });

// US-5.3 — charity_owner declines a pledge with a reason.
export async function POST(req: Request, { params }: { params: Promise<{ id: string }> }) {
  try {
    const session = await requireUser();
    const { id } = await params;
    const { reason } = schema.parse(await readJson(req));
    await declinePledge(session.userId, id, reason);
    return NextResponse.json({ ok: true, status: 'declined' });
  } catch (e) {
    return errorResponse(e);
  }
}
