import { NextResponse } from 'next/server';
import { confirmResourceGiftReceived } from '@/modules/commitments';
import { requireUser } from '@/lib/auth';
import { errorResponse } from '@/lib/http';

// US-6.5 — the charity confirms it received a gift.
export async function POST(_req: Request, { params }: { params: Promise<{ id: string }> }) {
  try {
    const session = await requireUser();
    const { id } = await params;
    await confirmResourceGiftReceived(session.userId, id);
    return NextResponse.json({ ok: true, status: 'received' });
  } catch (e) {
    return errorResponse(e);
  }
}
