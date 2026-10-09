import { NextResponse } from 'next/server';
import { markResourceGiftProvided } from '@/modules/commitments';
import { requireUser } from '@/lib/auth';
import { errorResponse } from '@/lib/http';

// US-6.5 — the donating corporation marks a gift as provided.
export async function POST(_req: Request, { params }: { params: Promise<{ id: string }> }) {
  try {
    const session = await requireUser();
    const { id } = await params;
    await markResourceGiftProvided(session.userId, id);
    return NextResponse.json({ ok: true, status: 'provided' });
  } catch (e) {
    return errorResponse(e);
  }
}
