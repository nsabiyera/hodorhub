import { NextResponse } from 'next/server';
import { z } from 'zod';
import { connectSocialAccount } from '@/modules/engagement';
import { requireUser } from '@/lib/auth';
import { readJson, errorResponse } from '@/lib/http';

const schema = z.object({
  platform: z.enum(['facebook', 'twitter']),
  accessToken: z.string().min(1),
  linkedPostRef: z.string().min(1).max(500),
});

// US-3.4 — charity_owner connects a social account + linked post (token encrypted).
export async function POST(req: Request, { params }: { params: Promise<{ id: string }> }) {
  try {
    const session = await requireUser();
    const { id } = await params;
    const { platform, accessToken, linkedPostRef } = schema.parse(await readJson(req));
    const { connectionId } = await connectSocialAccount(
      session.userId,
      id,
      platform,
      accessToken,
      linkedPostRef,
    );
    return NextResponse.json({ connectionId }, { status: 201 });
  } catch (e) {
    return errorResponse(e);
  }
}
