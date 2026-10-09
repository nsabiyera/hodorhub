import { NextResponse } from 'next/server';
import { logHours, logHoursSchema } from '@/modules/delivery';
import { requireUser } from '@/lib/auth';
import { readJson, errorResponse } from '@/lib/http';

// US-6.2 — the allocated volunteer logs hours (enter pending).
export async function POST(req: Request, { params }: { params: Promise<{ id: string }> }) {
  try {
    const session = await requireUser();
    const { id } = await params;
    const input = logHoursSchema.parse(await readJson(req));
    const { hourLogId } = await logHours(session.userId, id, input);
    return NextResponse.json({ hourLogId, status: 'pending' }, { status: 201 });
  } catch (e) {
    return errorResponse(e);
  }
}
