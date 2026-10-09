import { NextResponse } from 'next/server';
import { removeMember } from '@/modules/identity';
import { requireUser } from '@/lib/auth';
import { errorResponse } from '@/lib/http';

// US-10.7 — release a seat. Refuses to remove the last administrator, since an
// organisation with none could never invite anyone again.
export async function DELETE(
  _req: Request,
  { params }: { params: Promise<{ id: string; userId: string }> },
) {
  try {
    const session = await requireUser();
    const { id, userId } = await params;
    await removeMember(session.userId, id, userId);
    return NextResponse.json({ ok: true });
  } catch (e) {
    return errorResponse(e);
  }
}
