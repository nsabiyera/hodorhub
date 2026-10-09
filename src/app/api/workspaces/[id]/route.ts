import { NextResponse } from 'next/server';
import { getWorkspaceBoard } from '@/modules/delivery';
import { requireUser } from '@/lib/auth';
import { errorResponse } from '@/lib/http';

export const dynamic = 'force-dynamic';

// US-6.3 — the shared delivery board. Both organisations read the same board;
// anyone else gets a 404 rather than a 403.
export async function GET(_req: Request, { params }: { params: Promise<{ id: string }> }) {
  try {
    const session = await requireUser();
    const { id } = await params;
    return NextResponse.json(await getWorkspaceBoard(session.userId, id));
  } catch (e) {
    return errorResponse(e);
  }
}
