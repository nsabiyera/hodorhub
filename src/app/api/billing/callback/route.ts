import { NextResponse } from 'next/server';
import { activateSubscription } from '@/modules/monetisation';
import { getPaymentProvider } from '@/lib/payment-provider-factory';
import { env } from '@/config/env';
import { errorResponse } from '@/lib/http';

/**
 * US-10.6 — the payment provider's callback. Deliberately unauthenticated by
 * session: the caller is the provider, not a signed-in user. Its authority is
 * the SIGNATURE, verified inside the provider adapter — an unsigned or forged
 * body cannot produce a ConfirmedCheckout, so it can never activate a plan.
 *
 * The raw body is read as text, not JSON, because signature verification must
 * see exactly the bytes that were signed.
 */
export async function POST(req: Request) {
  try {
    const rawBody = await req.text();
    const signature = req.headers.get('x-payment-signature');
    const provider = getPaymentProvider(env.PAYMENT_PROVIDER);
    const confirmed = await provider.verifyCheckoutCallback(rawBody, signature);
    if (!confirmed) {
      return NextResponse.json({ error: 'invalid_signature' }, { status: 400 });
    }
    const { planCode } = await activateSubscription(confirmed);
    return NextResponse.json({ ok: true, planCode });
  } catch (e) {
    return errorResponse(e);
  }
}
