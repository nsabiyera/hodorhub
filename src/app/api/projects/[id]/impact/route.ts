import { NextResponse } from 'next/server';
import { getProjectImpact } from '@/modules/reporting';
import { requireUser } from '@/lib/auth';
import { errorResponse } from '@/lib/http';

// US-7.2 — the owning charity's impact summary for one project. Authorisation
// is inside getProjectImpact: a project outside the caller's charity is a 404,
// so impact data never leaks and a probe cannot tell "not yours" from "no such
// project".
export async function GET(_req: Request, { params }: { params: Promise<{ id: string }> }) {
  try {
    const session = await requireUser();
    const { id } = await params;
    return NextResponse.json(await getProjectImpact(session.userId, id));
  } catch (e) {
    return errorResponse(e);
  }
}
