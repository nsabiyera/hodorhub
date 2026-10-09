import { NextResponse } from 'next/server';
import { z } from 'zod';
import { requestPasswordReset } from '@/modules/identity';
import { env } from '@/config/env';
import { mailer } from '@/lib/mailer';
import { readJson, errorResponse } from '@/lib/http';

const schema = z.object({ email: z.string().email() });

// US-1.9 — request a password reset. Always responds 200 (anti-enumeration).
export async function POST(req: Request) {
  try {
    const { email } = schema.parse(await readJson(req));
    const result = await requestPasswordReset(email);
    if (result) {
      const link = `${env.PUBLIC_BASE_URL}/reset-password?token=${result.token}`;
      await mailer.send({
        to: email,
        subject: 'Reset your HodorHub password',
        text: `Reset your password: ${link}\nThis link expires in 30 minutes.`,
      });
    }
    return NextResponse.json({ ok: true });
  } catch (e) {
    return errorResponse(e);
  }
}
