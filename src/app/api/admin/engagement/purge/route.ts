import { NextResponse } from 'next/server';
import { z } from 'zod';
import { purgeEngagementOlderThan } from '@/modules/privacy';
import { requirePlatformAdmin } from '@/lib/auth';
import { readJson, errorResponse } from '@/lib/http';

const schema = z.object({ olderThanDays: z.number().int().min(1).max(3650) });

// GDPR retention — purge ingested social engagement older than N days.
export async function POST(req: Request) {
  try {
    await requirePlatformAdmin();
    const { olderThanDays } = schema.parse(await readJson(req));
    const cutoff = new Date(Date.now() - olderThanDays * 24 * 60 * 60 * 1000);
    const { purged } = await purgeEngagementOlderThan(cutoff);
    return NextResponse.json({ purged });
  } catch (e) {
    return errorResponse(e);
  }
}
