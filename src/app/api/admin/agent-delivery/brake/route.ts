import { NextResponse } from 'next/server';
import { setAgentDeliveryPaused, platformBrakeSchema } from '@/modules/agent-delivery';
import { requirePlatformAdmin } from '@/lib/auth';
import { errorResponse, readJson } from '@/lib/http';

// US-11.5 — reversible platform-wide brake: stops every agent-delivery run at
// its next step boundary without touching run statuses. Releasing it lets runs
// resume via the worker's reconciliation sweep.
export async function POST(req: Request) {
  try {
    const admin = await requirePlatformAdmin();
    const { paused } = platformBrakeSchema.parse(await readJson(req));
    await setAgentDeliveryPaused(admin.userId, paused);
    return NextResponse.json({ ok: true, agentDeliveryPaused: paused });
  } catch (e) {
    return errorResponse(e);
  }
}
