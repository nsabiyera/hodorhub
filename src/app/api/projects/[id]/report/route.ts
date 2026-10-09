import { NextResponse } from 'next/server';
import { z } from 'zod';
import { reportContent } from '@/modules/moderation';
import { requireUser } from '@/lib/auth';
import { readJson, errorResponse } from '@/lib/http';

const schema = z.object({ reason: z.string().min(1).max(1000) });

// US-9.2 — report a project for moderation.
export async function POST(req: Request, { params }: { params: Promise<{ id: string }> }) {
  try {
    const session = await requireUser();
    const { id } = await params;
    const { reason } = schema.parse(await readJson(req));
    const { reportId } = await reportContent(session.userId, id, reason);
    return NextResponse.json({ reportId }, { status: 201 });
  } catch (e) {
    return errorResponse(e);
  }
}
