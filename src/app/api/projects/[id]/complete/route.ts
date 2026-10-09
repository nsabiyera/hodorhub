import { NextResponse } from 'next/server';
import { completeProject, completeProjectSchema } from '@/modules/projects';
import { requireUser } from '@/lib/auth';
import { readJson, errorResponse } from '@/lib/http';

// US-7.3 — the charity marks a project complete with its outcome story. This is
// the only route to 'completed': the generic transition route deliberately no
// longer accepts it, so a completed project always has a result to show.
export async function POST(req: Request, { params }: { params: Promise<{ id: string }> }) {
  try {
    const session = await requireUser();
    const { id } = await params;
    const { outcomeStory } = completeProjectSchema.parse(await readJson(req));
    await completeProject(session.userId, id, outcomeStory);
    return NextResponse.json({ ok: true, status: 'completed' });
  } catch (e) {
    return errorResponse(e);
  }
}
