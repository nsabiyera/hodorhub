import { NextResponse } from 'next/server';
import { listConversationsForProject } from '@/modules/messaging';
import { requireUser } from '@/lib/auth';
import { errorResponse } from '@/lib/http';

export const dynamic = 'force-dynamic';

/**
 * US-8.3 — the conversations the caller may see on this project.
 *
 * Returns 200 with `[]` rather than 403/404 for someone with nothing: this is a
 * "what is mine" endpoint, an empty list is the truthful answer, and it never
 * returns thread contents, which is what the AC's 404 rule protects.
 */
export async function GET(_req: Request, { params }: { params: Promise<{ id: string }> }) {
  try {
    const session = await requireUser();
    const { id } = await params;
    return NextResponse.json({
      conversations: await listConversationsForProject(session.userId, id),
    });
  } catch (e) {
    return errorResponse(e);
  }
}
