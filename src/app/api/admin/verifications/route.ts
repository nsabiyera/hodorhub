import { NextResponse } from 'next/server';
import { listPendingVerifications } from '@/modules/identity';
import { requirePlatformAdmin } from '@/lib/auth';
import { errorResponse } from '@/lib/http';

export const dynamic = 'force-dynamic'; // reads the session cookie

// US-1.3 — the admin verification queue.
export async function GET() {
  try {
    await requirePlatformAdmin();
    return NextResponse.json({ pending: await listPendingVerifications() });
  } catch (e) {
    return errorResponse(e);
  }
}
