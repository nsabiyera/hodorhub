import { NextResponse } from 'next/server';
import { getPreferences, setPreference, preferenceUpdateSchema } from '@/modules/notifications';
import { requireUser } from '@/lib/auth';
import { readJson, errorResponse } from '@/lib/http';

export const dynamic = 'force-dynamic';

// US-8.2 — always the signed-in user's own preferences. There is deliberately
// no user id in the path: nobody reads or writes anyone else's settings.
export async function GET() {
  try {
    const session = await requireUser();
    return NextResponse.json({ kinds: await getPreferences(session.userId) });
  } catch (e) {
    return errorResponse(e);
  }
}

export async function PUT(req: Request) {
  try {
    const session = await requireUser();
    const input = preferenceUpdateSchema.parse(await readJson(req));
    await setPreference(session.userId, input);
    return NextResponse.json({ kinds: await getPreferences(session.userId) });
  } catch (e) {
    return errorResponse(e);
  }
}
