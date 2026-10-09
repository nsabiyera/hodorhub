import { NextResponse } from 'next/server';
import { z } from 'zod';
import { rejectHours } from '@/modules/delivery';
import { requireUser } from '@/lib/auth';
import { readJson, errorResponse } from '@/lib/http';

const schema = z.object({ reason: z.string().min(1).max(1000) });

// US-6.2a — CSR manager rejects logged hours with a reason.
export async function POST(req: Request, { params }: { params: Promise<{ id: string }> }) {
  try {
    const session = await requireUser();
    const { id } = await params;
    const { reason } = schema.parse(await readJson(req));
    await rejectHours(session.userId, id, reason);
    return NextResponse.json({ ok: true, status: 'rejected' });
  } catch (e) {
    return errorResponse(e);
  }
}
