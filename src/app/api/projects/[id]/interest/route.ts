import { NextResponse } from 'next/server';
import { z } from 'zod';
import { expressInterest } from '@/modules/commitments';
import { requireUser } from '@/lib/auth';
import { readJson, errorResponse } from '@/lib/http';

const schema = z.object({ corporationOrgId: z.string().uuid() });

// US-5.1 — a CSR manager expresses interest in a published project.
export async function POST(req: Request, { params }: { params: Promise<{ id: string }> }) {
  try {
    const session = await requireUser();
    const { id } = await params;
    const { corporationOrgId } = schema.parse(await readJson(req));
    const { interestId } = await expressInterest(session.userId, id, corporationOrgId);
    return NextResponse.json({ interestId }, { status: 201 });
  } catch (e) {
    return errorResponse(e);
  }
}
