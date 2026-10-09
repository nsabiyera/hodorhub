import { NextResponse } from 'next/server';
import { VOLUNTEER_SKILLS, SENIORITY_LEVELS } from '@/modules/identity';
import { errorResponse } from '@/lib/http';

export const dynamic = 'force-dynamic';

/**
 * US-1.5 — the controlled vocabularies the profile form offers. Read-only and
 * unauthenticated: it is a code-held registry of public labels, and deriving
 * the form from it is what stops a second drifting copy in the client.
 */
export async function GET() {
  try {
    return NextResponse.json({ skills: VOLUNTEER_SKILLS, seniority: SENIORITY_LEVELS });
  } catch (e) {
    return errorResponse(e);
  }
}
