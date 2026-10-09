import { NextResponse } from 'next/server';
import { z } from 'zod';
import { withdrawResourceGift } from '@/modules/commitments';
import { requireUser } from '@/lib/auth';
import { readJson, errorResponse } from '@/lib/http';

const schema = z.object({ reason: z.string().min(1).max(1000) });

// The donating corporation withdraws a gift (before it is received).
export async function POST(req: Request, { params }: { params: Promise<{ id: string }> }) {
  try {
    const session = await requireUser();
    const { id } = await params;
    const { reason } = schema.parse(await readJson(req));
    await withdrawResourceGift(session.userId, id, reason);
    return NextResponse.json({ ok: true, status: 'withdrawn' });
  } catch (e) {
    return errorResponse(e);
  }
}
