import { NextResponse } from 'next/server';
import { startSubscription, cancelSubscription, subscribeSchema } from '@/modules/monetisation';
import { getPaymentProvider } from '@/lib/payment-provider-factory';
import { env } from '@/config/env';
import { requireUser } from '@/lib/auth';
import { readJson, errorResponse } from '@/lib/http';

// US-10.6 — start a subscription. Returns the provider's checkout URL and
// changes nothing: entitlements move only once the provider confirms payment,
// on the verified callback.
export async function POST(req: Request, { params }: { params: Promise<{ id: string }> }) {
  try {
    const session = await requireUser();
    const { id } = await params;
    const { planCode } = subscribeSchema.parse(await readJson(req));
    const provider = getPaymentProvider(env.PAYMENT_PROVIDER);
    const origin = new URL(req.url).origin;
    const checkout = await startSubscription(
      session.userId,
      id,
      planCode,
      provider,
      `${origin}/billing`,
    );
    return NextResponse.json({ ok: true, ...checkout });
  } catch (e) {
    return errorResponse(e);
  }
}

// US-10.6 — cancel. Entitlements revert to Starter, which is what an absent
// active subscription already means.
export async function DELETE(_req: Request, { params }: { params: Promise<{ id: string }> }) {
  try {
    const session = await requireUser();
    const { id } = await params;
    await cancelSubscription(session.userId, id, getPaymentProvider(env.PAYMENT_PROVIDER));
    return NextResponse.json({ ok: true, planCode: 'starter' });
  } catch (e) {
    return errorResponse(e);
  }
}
