import { describe, it, expect } from 'vitest';
import { FakePaymentProvider } from './fake-payment-provider';
import { getPaymentProvider } from './payment-provider-factory';

const req = {
  organisationId: '11111111-1111-1111-1111-111111111111',
  planCode: 'team',
  returnUrl: 'http://localhost:3000/billing',
};

describe('FakePaymentProvider', () => {
  it('creates a checkout with a stable id and a url', async () => {
    const p = new FakePaymentProvider();
    const a = await p.createCheckout(req);
    const b = await p.createCheckout(req);

    expect(a.checkoutId).toBe(b.checkoutId); // deterministic
    expect(a.url).toContain(a.checkoutId);
  });

  it('confirms only a correctly signed callback for a known checkout', async () => {
    const p = new FakePaymentProvider();
    const { checkoutId } = await p.createCheckout(req);
    const body = JSON.stringify({ type: 'checkout.completed', checkoutId });

    expect(await p.verifyCheckoutCallback(body, null)).toBeNull();
    expect(await p.verifyCheckoutCallback(body, 'wrong')).toBeNull();

    const confirmed = await p.verifyCheckoutCallback(body, FakePaymentProvider.sign(body));
    expect(confirmed).not.toBeNull();
    expect(confirmed!.organisationId).toBe(req.organisationId);
    expect(confirmed!.planCode).toBe('team');
    expect(confirmed!.customerRef).toContain('fake_cus_');
    expect(confirmed!.subscriptionRef).toContain('fake_sub_');
  });

  it('verifies without shared state, so a different instance still confirms', async () => {
    // Next compiles each route into its own module graph in dev, so the
    // instance that created the checkout is not necessarily the one that sees
    // the callback. The id encodes what is needed.
    const { checkoutId } = await new FakePaymentProvider().createCheckout(req);
    const body = JSON.stringify({ type: 'checkout.completed', checkoutId });

    const confirmed = await new FakePaymentProvider().verifyCheckoutCallback(
      body,
      FakePaymentProvider.sign(body),
    );

    expect(confirmed).not.toBeNull();
    expect(confirmed!.organisationId).toBe(req.organisationId);
    expect(confirmed!.planCode).toBe('team');
  });

  it('ignores a signed callback for a malformed id or the wrong event', async () => {
    const p = new FakePaymentProvider();
    const { checkoutId } = await p.createCheckout(req);

    const unknown = JSON.stringify({ type: 'checkout.completed', checkoutId: 'nope' });
    expect(await p.verifyCheckoutCallback(unknown, FakePaymentProvider.sign(unknown))).toBeNull();

    const wrongEvent = JSON.stringify({ type: 'checkout.expired', checkoutId });
    expect(
      await p.verifyCheckoutCallback(wrongEvent, FakePaymentProvider.sign(wrongEvent)),
    ).toBeNull();
  });

  it('records cancellations and returns invoices for a customer', async () => {
    const p = new FakePaymentProvider();
    await p.cancelSubscription('fake_sub_1');
    expect(p.cancelled).toEqual(['fake_sub_1']);

    const invoices = await p.listInvoices('fake_cus_abcdef');
    expect(invoices).toHaveLength(1);
    expect(invoices[0]!.status).toBe('paid');
    expect(invoices[0]!.amountMinor).toBeGreaterThan(0);
  });
});

describe('getPaymentProvider', () => {
  it('returns the fake, and the same instance each time', () => {
    // One process-wide fake, so a checkout created by one request is still
    // known to the callback that completes it.
    expect(getPaymentProvider('fake')).toBe(getPaymentProvider('fake'));
  });

  it('throws for stripe until keys are wired, rather than falling back to the fake', () => {
    // A workspace must never be upgraded "for free" on a fake while an operator
    // believes it was paid for.
    expect(() => getPaymentProvider('stripe')).toThrow(/not wired yet/);
  });

  it('throws for an unknown provider name', () => {
    expect(() => getPaymentProvider('paypal')).toThrow(/not configured/);
  });
});
