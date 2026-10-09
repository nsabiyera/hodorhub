import { NextResponse } from 'next/server';
import { getProjectForOwner, getPublishedProject, updateDraftProject } from '@/modules/projects';
import { NotFoundError, ForbiddenError } from '@/modules/identity';
import { getSession, requireUser } from '@/lib/auth';
import { readJson, errorResponse } from '@/lib/http';

export const dynamic = 'force-dynamic'; // reads the session cookie

// US-2.1 / US-2.4 read: owner sees any status; everyone else only published states.
export async function GET(_req: Request, { params }: { params: Promise<{ id: string }> }) {
  try {
    const { id } = await params;
    const session = await getSession();
    if (session) {
      try {
        return NextResponse.json(await getProjectForOwner(session.userId, id));
      } catch (e) {
        // Not the owner (cross-tenant NotFound, or same-org non-owner Forbidden)
        // → fall through to the public view; only surface unexpected errors.
        if (!(e instanceof NotFoundError) && !(e instanceof ForbiddenError))
          return errorResponse(e);
      }
    }
    const pub = await getPublishedProject(id);
    if (!pub) return errorResponse(new NotFoundError('Project'));
    return NextResponse.json(pub);
  } catch (e) {
    return errorResponse(e);
  }
}

// US-2.1 — edit a draft's text fields.
export async function PATCH(req: Request, { params }: { params: Promise<{ id: string }> }) {
  try {
    const session = await requireUser();
    const { id } = await params;
    await updateDraftProject(session.userId, id, (await readJson(req)) as never);
    return NextResponse.json({ ok: true });
  } catch (e) {
    return errorResponse(e);
  }
}
