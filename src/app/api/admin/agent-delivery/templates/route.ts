import { NextResponse } from 'next/server';
import { AGENT_DELIVERY_TEMPLATES } from '@/modules/agent-delivery';
import { requirePlatformAdmin } from '@/lib/auth';
import { errorResponse } from '@/lib/http';

// US-11.12 — the allow-list a platform admin is accountable for, read-only by
// design. Widening it is a reviewed code change carrying eval evidence, not a
// runtime toggle: an editable list is precisely how the "only as evals prove
// new shapes" rule would erode.
export async function GET() {
  try {
    await requirePlatformAdmin();
    return NextResponse.json({ templates: AGENT_DELIVERY_TEMPLATES });
  } catch (e) {
    return errorResponse(e);
  }
}
