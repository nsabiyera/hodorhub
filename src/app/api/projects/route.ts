import { NextResponse } from 'next/server';
import { createDraftProject } from '@/modules/projects';
import { requireUser } from '@/lib/auth';
import { readJson, errorResponse } from '@/lib/http';

// US-2.1 — create a draft project (owner = charity_owner of body.charityOrgId).
export async function POST(req: Request) {
  try {
    const session = await requireUser();
    const body = (await readJson(req)) as Record<string, unknown>;
    const { projectId } = await createDraftProject(session.userId, body as never);
    return NextResponse.json({ projectId, status: 'draft' }, { status: 201 });
  } catch (e) {
    return errorResponse(e);
  }
}
