import { NextResponse } from 'next/server';
import { getWorkspaceHours } from '@/modules/delivery';
import { requireUser } from '@/lib/auth';
import { errorResponse } from '@/lib/http';

export const dynamic = 'force-dynamic';

// US-6.2a reporting — approved vs pending hours, kept distinct.
export async function GET(_req: Request, { params }: { params: Promise<{ id: string }> }) {
  try {
    const session = await requireUser();
    const { id } = await params;
    return NextResponse.json(await getWorkspaceHours(session.userId, id));
  } catch (e) {
    return errorResponse(e);
  }
}
