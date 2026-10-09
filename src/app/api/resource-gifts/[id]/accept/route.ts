import { NextResponse } from 'next/server';
import { acceptResourceGift } from '@/modules/commitments';
import { requireUser } from '@/lib/auth';
import { errorResponse } from '@/lib/http';

// US-5.5 — charity_owner accepts a resource gift (no delivery is started).
export async function POST(_req: Request, { params }: { params: Promise<{ id: string }> }) {
  try {
    const session = await requireUser();
    const { id } = await params;
    await acceptResourceGift(session.userId, id);
    return NextResponse.json({ ok: true, status: 'accepted' });
  } catch (e) {
    return errorResponse(e);
  }
}
