import { NextResponse } from 'next/server';
import { setRunStatus, runStatusSchema } from '@/modules/agent-delivery';
import { requirePlatformAdmin } from '@/lib/auth';
import { errorResponse, readJson } from '@/lib/http';

// US-11.5 — a platform admin pauses, resumes, or halts one agent-delivery run.
// setRunStatus re-checks admin rights against the database; this gate only
// filters on the session claim (tech-debt M4).
export async function POST(req: Request, { params }: { params: Promise<{ id: string }> }) {
  try {
    const admin = await requirePlatformAdmin();
    const { id } = await params;
    const { status } = runStatusSchema.parse(await readJson(req));
    await setRunStatus(admin.userId, id, status);
    return NextResponse.json({ ok: true, status });
  } catch (e) {
    return errorResponse(e);
  }
}
