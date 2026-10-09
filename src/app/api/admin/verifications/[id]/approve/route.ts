import { NextResponse } from 'next/server';
import { approveVerification } from '@/modules/identity';
import { requirePlatformAdmin } from '@/lib/auth';
import { errorResponse } from '@/lib/http';

// US-1.3 — approve an organisation's verification.
export async function POST(_req: Request, { params }: { params: Promise<{ id: string }> }) {
  try {
    const admin = await requirePlatformAdmin();
    const { id } = await params;
    await approveVerification(id, admin.userId);
    return NextResponse.json({ ok: true, status: 'verified' });
  } catch (e) {
    return errorResponse(e);
  }
}
