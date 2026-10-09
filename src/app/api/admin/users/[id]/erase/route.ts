import { NextResponse } from 'next/server';
import { eraseUser } from '@/modules/privacy';
import { requirePlatformAdmin } from '@/lib/auth';
import { errorResponse } from '@/lib/http';

// GDPR right-to-erasure — admin erases a user on request.
export async function POST(_req: Request, { params }: { params: Promise<{ id: string }> }) {
  try {
    await requirePlatformAdmin();
    const { id } = await params;
    await eraseUser(id);
    return NextResponse.json({ ok: true, erased: true });
  } catch (e) {
    return errorResponse(e);
  }
}
