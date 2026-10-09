import { NextResponse } from 'next/server';
import { z } from 'zod';
import { setDigitalResourceNeeds, digitalResourceNeedSchema } from '@/modules/projects';
import { requireUser } from '@/lib/auth';
import { readJson, errorResponse } from '@/lib/http';

const schema = z.object({ needs: z.array(digitalResourceNeedSchema) });

// US-2.7 — replace the project's digital-resource needs.
export async function PUT(req: Request, { params }: { params: Promise<{ id: string }> }) {
  try {
    const session = await requireUser();
    const { id } = await params;
    const { needs } = schema.parse(await readJson(req));
    await setDigitalResourceNeeds(session.userId, id, needs);
    return NextResponse.json({ ok: true });
  } catch (e) {
    return errorResponse(e);
  }
}
