import { NextResponse } from 'next/server';
import { listOpenReports } from '@/modules/moderation';
import { requirePlatformAdmin } from '@/lib/auth';
import { errorResponse } from '@/lib/http';

export const dynamic = 'force-dynamic';

// US-9.1 — the admin moderation queue.
export async function GET() {
  try {
    const admin = await requirePlatformAdmin();
    return NextResponse.json({ reports: await listOpenReports(admin.userId) });
  } catch (e) {
    return errorResponse(e);
  }
}
