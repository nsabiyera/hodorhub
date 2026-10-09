import { NextResponse } from 'next/server';
import { z } from 'zod';
import { authenticate } from '@/modules/identity';
import { readJson, errorResponse, clientIp, enforceLimit } from '@/lib/http';
import { createRateLimiter } from '@/lib/ratelimit';
import { signSession, newSession, SESSION_COOKIE } from '@/lib/session';
import { isProd } from '@/config/env';

const schema = z.object({ email: z.string().email(), password: z.string().min(1) });

// 10 attempts / minute / IP — blunts credential stuffing + argon2 CPU-DoS (H1).
const limiter = createRateLimiter(10, 60_000);

export async function POST(req: Request) {
  try {
    enforceLimit(limiter(clientIp(req)));
    const { email, password } = schema.parse(await readJson(req));
    const { userId, isPlatformAdmin } = await authenticate(email, password);

    const res = NextResponse.json({ ok: true, isPlatformAdmin });
    res.cookies.set(SESSION_COOKIE, signSession(newSession(userId, isPlatformAdmin)), {
      httpOnly: true,
      secure: isProd,
      sameSite: 'lax',
      path: '/',
      maxAge: 60 * 60 * 24 * 7,
    });
    return res;
  } catch (e) {
    return errorResponse(e);
  }
}
