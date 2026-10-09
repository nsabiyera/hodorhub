import { NextResponse } from 'next/server';
import { registerCharity, requestEmailVerification } from '@/modules/identity';
import { env } from '@/config/env';
import { mailer } from '@/lib/mailer';
import { readJson, errorResponse, clientIp, enforceLimit } from '@/lib/http';
import { createRateLimiter } from '@/lib/ratelimit';

const limiter = createRateLimiter(5, 60_000); // 5 registrations / min / IP (H1)

// US-1.1 — public charity registration. Org is created in `pending` state,
// and a verification email (US-1.8) is sent to the registrant.
export async function POST(req: Request) {
  try {
    enforceLimit(limiter(clientIp(req)));
    const body = (await readJson(req)) as { email?: string };
    const result = await registerCharity(body as never);
    await sendVerification(result.userId, body.email);
    return NextResponse.json(
      { organisationId: result.organisationId, status: 'pending' },
      { status: 201 },
    );
  } catch (e) {
    return errorResponse(e);
  }
}

async function sendVerification(userId: string, email?: string) {
  if (!email) return;
  const token = await requestEmailVerification(userId);
  const link = `${env.PUBLIC_BASE_URL}/verify-email?token=${token}`;
  await mailer.send({
    to: email,
    subject: 'Verify your HodorHub email',
    text: `Confirm your email: ${link}`,
  });
}
