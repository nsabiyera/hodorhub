import { NextResponse } from 'next/server';
import {
  offerResourceGift,
  listResourceGiftsForProject,
  resourceGiftSchema,
} from '@/modules/commitments';
import { requireUser } from '@/lib/auth';
import { readJson, errorResponse } from '@/lib/http';

export const dynamic = 'force-dynamic';

// US-5.5 — a CSR manager offers an in-kind resource gift to a published project.
export async function POST(req: Request, { params }: { params: Promise<{ id: string }> }) {
  try {
    const session = await requireUser();
    const { id } = await params;
    const input = resourceGiftSchema.parse(await readJson(req));
    const { giftId } = await offerResourceGift(session.userId, id, input);
    return NextResponse.json({ giftId, status: 'offered' }, { status: 201 });
  } catch (e) {
    return errorResponse(e);
  }
}

// US-5.5 — the charity_owner lists resource gifts on its project.
export async function GET(_req: Request, { params }: { params: Promise<{ id: string }> }) {
  try {
    const session = await requireUser();
    const { id } = await params;
    return NextResponse.json({ gifts: await listResourceGiftsForProject(session.userId, id) });
  } catch (e) {
    return errorResponse(e);
  }
}
