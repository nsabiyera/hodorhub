import { NextResponse } from 'next/server';
import { computeBudgetSchema, fundComputeBudget } from '@/modules/commitments';
import { requireUser } from '@/lib/auth';
import { errorResponse, readJson } from '@/lib/http';

// US-11.1 — a CSR manager funds a compute budget for a published project.
export async function POST(req: Request, { params }: { params: Promise<{ id: string }> }) {
  try {
    const session = await requireUser();
    const { id } = await params;
    const body = computeBudgetSchema.parse(await readJson(req));
    const { computePledgeId } = await fundComputeBudget(session.userId, id, body);
    return NextResponse.json({ ok: true, computePledgeId });
  } catch (e) {
    return errorResponse(e);
  }
}
