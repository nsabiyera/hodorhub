import { NextResponse } from 'next/server';
import { z } from 'zod';
import { resolveReport } from '@/modules/moderation';
import { requirePlatformAdmin } from '@/lib/auth';
import { readJson, errorResponse } from '@/lib/http';

const schema = z.object({
  action: z.enum(['remove', 'dismiss']),
  reason: z.string().max(1000).optional(),
});

// US-9.1 — admin resolves a report (remove the project, or dismiss the report).
export async function POST(req: Request, { params }: { params: Promise<{ id: string }> }) {
  try {
    const admin = await requirePlatformAdmin();
    const { id } = await params;
    const { action, reason } = schema.parse(await readJson(req));
    await resolveReport(admin.userId, id, action, reason ?? null);
    return NextResponse.json({ ok: true, action });
  } catch (e) {
    return errorResponse(e);
  }
}
