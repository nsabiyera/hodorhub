import { NextResponse } from 'next/server';
import { requestProductionPromotion } from '@/modules/agent-delivery';
import { requireUser } from '@/lib/auth';
import { errorResponse } from '@/lib/http';

// US-11.8 — the charity owner explicitly approves promoting the delivered app
// to production. This records intent only; the privileged deployer runs in the
// worker, so no deploy credentials live in the web tier and a slow real deploy
// never sits under this request.
export async function POST(_req: Request, { params }: { params: Promise<{ id: string }> }) {
  try {
    const session = await requireUser();
    const { id } = await params;
    const { promotionId } = await requestProductionPromotion(session.userId, id);
    return NextResponse.json({ ok: true, promotionId, status: 'deploying' });
  } catch (e) {
    return errorResponse(e);
  }
}
