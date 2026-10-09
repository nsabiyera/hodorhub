import { NextResponse } from 'next/server';
import { z } from 'zod';
import { transitionProjectStatus } from '@/modules/projects';
import { requireUser } from '@/lib/auth';
import { readJson, errorResponse } from '@/lib/http';

// US-7.3 — 'completed' is deliberately absent: completing a project carries an
// outcome story, so it goes through POST /api/projects/[id]/complete instead.
const schema = z.object({
  to: z.enum(['draft', 'published', 'in_delivery', 'archived']),
});

// US-2.4 — move a project through its lifecycle (in_delivery / archived / reopen).
export async function POST(req: Request, { params }: { params: Promise<{ id: string }> }) {
  try {
    const session = await requireUser();
    const { id } = await params;
    const { to } = schema.parse(await readJson(req));
    await transitionProjectStatus(session.userId, id, to);
    return NextResponse.json({ ok: true, status: to });
  } catch (e) {
    return errorResponse(e);
  }
}
