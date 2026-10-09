import { NextResponse } from 'next/server';
import { pledgeResources, listPledgesForProject, pledgeSchema } from '@/modules/commitments';
import { requireUser } from '@/lib/auth';
import { readJson, errorResponse } from '@/lib/http';

export const dynamic = 'force-dynamic';

// US-5.2 — a CSR manager pledges donated resources to a published project.
export async function POST(req: Request, { params }: { params: Promise<{ id: string }> }) {
  try {
    const session = await requireUser();
    const { id } = await params;
    const input = pledgeSchema.parse(await readJson(req));
    const { pledgeId } = await pledgeResources(session.userId, id, input);
    return NextResponse.json({ pledgeId, status: 'proposed' }, { status: 201 });
  } catch (e) {
    return errorResponse(e);
  }
}

// US-5.3 — the charity_owner lists pledges on its project.
export async function GET(_req: Request, { params }: { params: Promise<{ id: string }> }) {
  try {
    const session = await requireUser();
    const { id } = await params;
    return NextResponse.json({ pledges: await listPledgesForProject(session.userId, id) });
  } catch (e) {
    return errorResponse(e);
  }
}
