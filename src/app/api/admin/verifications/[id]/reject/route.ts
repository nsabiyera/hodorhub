import { NextResponse } from 'next/server';
import { z } from 'zod';
import { rejectVerification } from '@/modules/identity';
import { requirePlatformAdmin } from '@/lib/auth';
import { readJson, errorResponse } from '@/lib/http';

const schema = z.object({ reason: z.string().min(1).max(1000) });

// US-1.3 — reject an organisation's verification with a reason.
export async function POST(req: Request, { params }: { params: Promise<{ id: string }> }) {
  try {
    const admin = await requirePlatformAdmin();
    const { id } = await params;
    const { reason } = schema.parse(await readJson(req));
    await rejectVerification(id, admin.userId, reason);
    return NextResponse.json({ ok: true, status: 'rejected' });
  } catch (e) {
    return errorResponse(e);
  }
}
