import { NextResponse } from 'next/server';
import { getMyProfile, saveMyProfile, deleteMyProfile, profileSchema } from '@/modules/identity';
import { requireUser } from '@/lib/auth';
import { readJson, errorResponse } from '@/lib/http';

export const dynamic = 'force-dynamic';

// US-1.5 — always the signed-in user's own profile. There is deliberately no
// user id in the path: nobody reads or writes anyone else's availability here.
// (A CSR manager sees their team through the roster read instead.)
export async function GET() {
  try {
    const session = await requireUser();
    return NextResponse.json(await getMyProfile(session.userId));
  } catch (e) {
    return errorResponse(e);
  }
}

export async function PUT(req: Request) {
  try {
    const session = await requireUser();
    const input = profileSchema.parse(await readJson(req));
    return NextResponse.json(await saveMyProfile(session.userId, input));
  } catch (e) {
    return errorResponse(e);
  }
}

/** Back to *no stated availability*. Allocations and logged hours are untouched. */
export async function DELETE() {
  try {
    const session = await requireUser();
    await deleteMyProfile(session.userId);
    return NextResponse.json(await getMyProfile(session.userId));
  } catch (e) {
    return errorResponse(e);
  }
}
