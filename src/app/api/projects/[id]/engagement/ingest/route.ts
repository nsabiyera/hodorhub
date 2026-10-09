import { NextResponse } from 'next/server';
import { z } from 'zod';
import { ingestEngagement, confirmPendingEngagement } from '@/modules/engagement';
import { requirePlatformAdmin } from '@/lib/auth';
import { readJson, errorResponse } from '@/lib/http';

// System-driven ingestion of social engagement (US-3.5). Admin-gated for the MVP
// (represents the scheduled sync); a Cloud Scheduler → this endpoint in prod.
const eventSchema = z.object({
  source: z.enum(['facebook', 'twitter']),
  action: z.string().min(1).max(40),
  actorRef: z.string().max(200).optional(),
  externalEventId: z.string().min(1).max(200),
  occurredAt: z.string().datetime(),
  trust: z.number().min(0).max(100),
});
const schema = z.object({ events: z.array(eventSchema).max(1000) });

export async function POST(req: Request, { params }: { params: Promise<{ id: string }> }) {
  try {
    await requirePlatformAdmin();
    const { id } = await params;
    const { events } = schema.parse(await readJson(req));
    const { ingested } = await ingestEngagement(id, events);
    const { confirmed, flagged } = await confirmPendingEngagement(id);
    return NextResponse.json({ ingested, confirmed, flagged });
  } catch (e) {
    return errorResponse(e);
  }
}
