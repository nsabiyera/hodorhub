import { NextResponse } from 'next/server';
import { z } from 'zod';
import { resetPassword } from '@/modules/identity';
import { readJson, errorResponse } from '@/lib/http';

const schema = z.object({ token: z.string().min(1), password: z.string().min(10).max(200) });

// US-1.9 — set a new password using a valid reset token.
export async function POST(req: Request) {
  try {
    const { token, password } = schema.parse(await readJson(req));
    await resetPassword(token, password);
    return NextResponse.json({ ok: true });
  } catch (e) {
    return errorResponse(e);
  }
}
