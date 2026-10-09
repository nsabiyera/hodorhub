import { NextResponse } from 'next/server';
import { acceptPledge } from '@/modules/commitments';
import { requireUser } from '@/lib/auth';
import { errorResponse } from '@/lib/http';

// US-5.3 — charity_owner accepts a pledge → project enters delivery.
export async function POST(_req: Request, { params }: { params: Promise<{ id: string }> }) {
  try {
    const session = await requireUser();
    const { id } = await params;
    const { deliveryWorkspaceId } = await acceptPledge(session.userId, id);
    return NextResponse.json({ ok: true, status: 'accepted', deliveryWorkspaceId });
  } catch (e) {
    return errorResponse(e);
  }
}
