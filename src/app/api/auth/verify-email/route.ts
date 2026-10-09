import { NextResponse } from 'next/server';
import { z } from 'zod';
import { verifyEmail } from '@/modules/identity';
import { readJson, errorResponse } from '@/lib/http';

const schema = z.object({ token: z.string().min(1) });

// US-1.8 — confirm an email address via the verification token.
export async function POST(req: Request) {
  try {
    const { token } = schema.parse(await readJson(req));
    await verifyEmail(token);
    return NextResponse.json({ ok: true, emailVerified: true });
  } catch (e) {
    return errorResponse(e);
  }
}
