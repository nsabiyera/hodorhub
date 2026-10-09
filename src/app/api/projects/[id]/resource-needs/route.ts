import { NextResponse } from 'next/server';
import { z } from 'zod';
import { setResourceNeeds, resourceNeedSchema } from '@/modules/projects';
import { requireUser } from '@/lib/auth';
import { readJson, errorResponse } from '@/lib/http';

const schema = z.object({ needs: z.array(resourceNeedSchema) });

// US-2.2 — replace the project's resource needs.
export async function PUT(req: Request, { params }: { params: Promise<{ id: string }> }) {
  try {
    const session = await requireUser();
    const { id } = await params;
    const { needs } = schema.parse(await readJson(req));
    await setResourceNeeds(session.userId, id, needs);
    return NextResponse.json({ ok: true });
  } catch (e) {
    return errorResponse(e);
  }
}
