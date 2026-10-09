import { NextResponse } from 'next/server';
import { approveHours } from '@/modules/delivery';
import { requireUser } from '@/lib/auth';
import { errorResponse } from '@/lib/http';

// US-6.2a — CSR manager approves logged hours (they now count).
export async function POST(_req: Request, { params }: { params: Promise<{ id: string }> }) {
  try {
    const session = await requireUser();
    const { id } = await params;
    await approveHours(session.userId, id);
    return NextResponse.json({ ok: true, status: 'approved' });
  } catch (e) {
    return errorResponse(e);
  }
}
