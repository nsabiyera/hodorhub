import { NextResponse } from 'next/server';
import { getCorporateImpact } from '@/modules/reporting';
import { requireUser } from '@/lib/auth';
import { errorResponse } from '@/lib/http';

// US-7.1 — a CSR manager's cross-project impact for their own corporation.
// Every underlying read re-checks CSR membership of this organisation, so a
// non-member gets 404 and a member with the wrong role gets 403.
export async function GET(_req: Request, { params }: { params: Promise<{ id: string }> }) {
  try {
    const session = await requireUser();
    const { id } = await params;
    return NextResponse.json(await getCorporateImpact(session.userId, id));
  } catch (e) {
    return errorResponse(e);
  }
}
