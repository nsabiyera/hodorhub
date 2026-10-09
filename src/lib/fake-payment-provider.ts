import { createHash } from 'node:crypto';
import type {
  PaymentProviderClient,
  CheckoutRequest,
  CheckoutSession,
  ConfirmedCheckout,
  Invoice,
} from './payment-provider';

/**
 * Deterministic, offline PaymentProviderClient. No money moves and no network
 * call is made, so the whole subscribe → entitlements → invoices flow can be
 * driven in dev and in tests.
 *
 * The callback signature is a plain hash of the body rather than an HMAC: this
 * is a stand-in that proves the ROUTE refuses unsigned payloads, not a security
 * control. A real provider verifies with its own signing secret.
 */
export class FakePaymentProvider implements PaymentProviderClient {
  public readonly checkouts = new Map<string, CheckoutRequest>();
  public readonly cancelled: string[] = [];

  /**
   * The checkout id ENCODES the organisation and plan rather than pointing at
   * an in-memory map. A real provider looks the session up in its own store;
   * this fake has no store, and must not pretend to — Next compiles each route
   * into its own module graph in dev, so a module-level Map created by the
   * subscribe route is not the one the callback route would read. Encoding the
   * state makes verification work across module instances, restarts and
   * processes, which is what a real provider's behaviour looks like from here.
   */
  async createCheckout(req: CheckoutRequest): Promise<CheckoutSession> {
    const payload = Buffer.from(`${req.organisationId}:${req.planCode}`).toString('base64url');
    const checkoutId = `fake_cs_${payload}`;
    this.checkouts.set(checkoutId, req);
    return { checkoutId, url: `https://pay.example.test/checkout/${checkoutId}` };
  }

  /** Decode a checkout id back to what it was created for. */
  private static decode(checkoutId: string): { organisationId: string; planCode: string } | null {
    if (!checkoutId.startsWith('fake_cs_')) return null;
    try {
      const [organisationId, planCode] = Buffer.from(
        checkoutId.slice('fake_cs_'.length),
        'base64url',
      )
        .toString('utf8')
        .split(':');
      if (!organisationId || !planCode) return null;
      return { organisationId, planCode };
    } catch {
      return null;
    }
  }

  static sign(rawBody: string): string {
    return createHash('sha256').update(`fake-signing-secret:${rawBody}`).digest('hex');
  }

  async verifyCheckoutCallback(
    rawBody: string,
    signature: string | null,
  ): Promise<ConfirmedCheckout | null> {
    if (!signature || signature !== FakePaymentProvider.sign(rawBody)) return null;
    const payload = JSON.parse(rawBody) as { type?: string; checkoutId?: string };
    if (payload.type !== 'checkout.completed' || !payload.checkoutId) return null;
    const decoded = FakePaymentProvider.decode(payload.checkoutId);
    if (!decoded) return null;
    return {
      checkoutId: payload.checkoutId,
      organisationId: decoded.organisationId,
      planCode: decoded.planCode,
      customerRef: `fake_cus_${decoded.organisationId.slice(0, 8)}`,
      subscriptionRef: `fake_sub_${payload.checkoutId.slice(-8)}`,
    };
  }

  async cancelSubscription(subscriptionRef: string): Promise<void> {
    this.cancelled.push(subscriptionRef);
  }

  async listInvoices(customerRef: string): Promise<Invoice[]> {
    return [
      {
        id: `fake_in_${customerRef.slice(-6)}`,
        amountMinor: 9900,
        currency: 'GBP',
        status: 'paid',
        issuedAt: '2026-09-01T00:00:00.000Z',
        url: `https://pay.example.test/invoice/${customerRef.slice(-6)}`,
      },
    ];
  }
}
