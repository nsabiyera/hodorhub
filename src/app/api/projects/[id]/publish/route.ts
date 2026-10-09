import { NextResponse } from 'next/server';
import { publishProject } from '@/modules/projects';
import { requireUser } from '@/lib/auth';
import { errorResponse } from '@/lib/http';

// US-2.1 — publish a draft (verified charity + complete fields required).
export async function POST(_req: Request, { params }: { params: Promise<{ id: string }> }) {
  try {
    const session = await requireUser();
    const { id } = await params;
    await publishProject(session.userId, id);
    return NextResponse.json({ ok: true, status: 'published' });
  } catch (e) {
    return errorResponse(e);
  }
}
