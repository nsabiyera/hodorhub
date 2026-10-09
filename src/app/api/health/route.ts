import { NextResponse } from 'next/server';
import { sql } from 'drizzle-orm';
import { db } from '@/db';

// Must run per-request, never statically baked at build time — otherwise the
// probe would cache a build-time result and never reflect real DB state.
export const dynamic = 'force-dynamic';

/**
 * Liveness + DB readiness probe. Used by Docker/Caddy healthchecks and CI smoke.
 */
export async function GET() {
  try {
    await db.execute(sql`select 1`);
    return NextResponse.json({ status: 'ok', db: 'up' });
  } catch {
    return NextResponse.json({ status: 'degraded', db: 'down' }, { status: 503 });
  }
}
