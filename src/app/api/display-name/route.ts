import { NextResponse } from 'next/server';
import { z } from 'zod';
import { setDisplayName, displayNameSchema } from '@/modules/identity';
import { requireUser } from '@/lib/auth';
import { readJson, errorResponse } from '@/lib/http';

export const dynamic = 'force-dynamic';

// Separate from /api/profile on purpose: a user with NO membership — a
// supporter, a platform admin — must still be able to be named to other people.
const schema = z.object({ displayName: displayNameSchema.nullable() });

export async function PUT(req: Request) {
  try {
    const session = await requireUser();
    const { displayName } = schema.parse(await readJson(req));
    return NextResponse.json(await setDisplayName(session.userId, displayName));
  } catch (e) {
    return errorResponse(e);
  }
}
