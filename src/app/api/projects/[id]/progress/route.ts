import { NextResponse } from 'next/server';
import { getDeliveryProgress } from '@/modules/delivery';
import { requireUser } from '@/lib/auth';
import { errorResponse } from '@/lib/http';

export const dynamic = 'force-dynamic';

// US-6.4 — the charity owner's read of delivery progress against the goal.
export async function GET(_req: Request, { params }: { params: Promise<{ id: string }> }) {
  try {
    const session = await requireUser();
    const { id } = await params;
    return NextResponse.json(await getDeliveryProgress(session.userId, id));
  } catch (e) {
    return errorResponse(e);
  }
}
