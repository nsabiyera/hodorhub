import { describe, it, expect } from 'vitest';
import { eq } from 'drizzle-orm';
import { testDb } from '@/test/db';
import { subscriptions } from '@/db/schema';
import { ForbiddenError, InvalidStateError, NotFoundError, inviteMember } from '@/modules/identity';
import { FakePaymentProvider } from '@/lib/fake-payment-provider';
import { twoOrgs } from '@/test/agent-delivery-fixtures';
import {
  startSubscription,
  activateSubscription,
  cancelSubscription,
  listInvoices,
} from './billing';
import { hasEntitlement, getPlanForOrg, getSeatUsage } from './service';
import { FEATURES } from './plans';

const RETURN_URL = 'http://localhost:3000/billing';

/** Drive a full checkout the way the provider would: start, sign, call back. */
async function subscribeTo(
  provider: FakePaymentProvider,
  actor: string,
  organisationId: string,
  planCode: string,
) {
  const checkout = await startSubscription(
    actor,
    organisationId,
    planCode,
    provider,
    RETURN_URL,
    testDb,
  );
  const body = JSON.stringify({ type: 'checkout.completed', checkoutId: checkout.checkoutId });
  const confirmed = await provider.verifyCheckoutCallback(body, FakePaymentProvider.sign(body));
  return activateSubscription(confirmed!, testDb);
}

describe('subscribe and manage billing (US-10.6)', () => {
  it('starting a checkout changes nothing until the provider confirms', async () => {
    const { corp } = await twoOrgs();
    const provider = new FakePaymentProvider();

    const checkout = await startSubscription(
      corp.userId,
      corp.organisationId,
      'team',
      provider,
      RETURN_URL,
      testDb,
    );

    expect(checkout.url).toContain('checkout');
    // Money has not moved, so nothing may have changed.
    expect(await testDb.select().from(subscriptions)).toHaveLength(0);
    expect((await getPlanForOrg(corp.organisationId, testDb)).code).toBe('starter');
    expect(await hasEntitlement(corp.organisationId, FEATURES.csrDashboard, testDb)).toBe(false);
  });

  it('entitlements update once the checkout is confirmed — the AC', async () => {
    const { corp } = await twoOrgs();
    const provider = new FakePaymentProvider();

    expect(await hasEntitlement(corp.organisationId, FEATURES.csrDashboard, testDb)).toBe(false);
    await subscribeTo(provider, corp.userId, corp.organisationId, 'team');

    expect((await getPlanForOrg(corp.organisationId, testDb)).code).toBe('team');
    expect(await hasEntitlement(corp.organisationId, FEATURES.csrDashboard, testDb)).toBe(true);
    expect(await hasEntitlement(corp.organisationId, FEATURES.customDomain, testDb)).toBe(false);
  });

  it('raises the seat limit as part of the same upgrade', async () => {
    const { corp } = await twoOrgs();
    expect((await getSeatUsage(corp.organisationId, testDb)).seatLimit).toBe(5);

    await subscribeTo(new FakePaymentProvider(), corp.userId, corp.organisationId, 'team');

    expect((await getSeatUsage(corp.organisationId, testDb)).seatLimit).toBe(50);
  });

  it('invoices are available after subscribing — the other half of the AC', async () => {
    const { corp } = await twoOrgs();
    const provider = new FakePaymentProvider();
    await subscribeTo(provider, corp.userId, corp.organisationId, 'team');

    const invoices = await listInvoices(corp.userId, corp.organisationId, provider, testDb);

    expect(invoices.length).toBeGreaterThan(0);
    expect(invoices[0]!.status).toBe('paid');
    expect(invoices[0]!.currency).toBe('GBP');
  });

  it('an organisation that never paid has no invoices, not an error', async () => {
    const { corp } = await twoOrgs();
    await expect(
      listInvoices(corp.userId, corp.organisationId, new FakePaymentProvider(), testDb),
    ).resolves.toEqual([]);
  });

  it('a replayed callback does not stack subscriptions', async () => {
    const { corp } = await twoOrgs();
    const provider = new FakePaymentProvider();
    const checkout = await startSubscription(
      corp.userId,
      corp.organisationId,
      'team',
      provider,
      RETURN_URL,
      testDb,
    );
    const body = JSON.stringify({ type: 'checkout.completed', checkoutId: checkout.checkoutId });
    const confirmed = await provider.verifyCheckoutCallback(body, FakePaymentProvider.sign(body));

    await activateSubscription(confirmed!, testDb);
    await activateSubscription(confirmed!, testDb); // providers retry

    const active = await testDb
      .select()
      .from(subscriptions)
      .where(eq(subscriptions.status, 'active'));
    expect(active).toHaveLength(1);
    expect((await getPlanForOrg(corp.organisationId, testDb)).code).toBe('team');
  });

  it('upgrading again supersedes the previous plan rather than stacking', async () => {
    const { corp } = await twoOrgs();
    const provider = new FakePaymentProvider();
    await subscribeTo(provider, corp.userId, corp.organisationId, 'team');
    await subscribeTo(provider, corp.userId, corp.organisationId, 'enterprise');

    const active = await testDb
      .select()
      .from(subscriptions)
      .where(eq(subscriptions.status, 'active'));
    expect(active).toHaveLength(1);
    expect((await getPlanForOrg(corp.organisationId, testDb)).code).toBe('enterprise');
    expect(await hasEntitlement(corp.organisationId, FEATURES.customDomain, testDb)).toBe(true);
  });

  it('cancelling reverts entitlements to Starter', async () => {
    const { corp } = await twoOrgs();
    const provider = new FakePaymentProvider();
    await subscribeTo(provider, corp.userId, corp.organisationId, 'team');

    await cancelSubscription(corp.userId, corp.organisationId, provider, testDb);

    expect((await getPlanForOrg(corp.organisationId, testDb)).code).toBe('starter');
    expect(await hasEntitlement(corp.organisationId, FEATURES.csrDashboard, testDb)).toBe(false);
    expect(provider.cancelled).toHaveLength(1); // told the provider too
  });

  it('refuses to cancel when there is nothing active', async () => {
    const { corp } = await twoOrgs();
    await expect(
      cancelSubscription(corp.userId, corp.organisationId, new FakePaymentProvider(), testDb),
    ).rejects.toBeInstanceOf(InvalidStateError);
  });

  it('refuses to sell the free plan', async () => {
    const { corp } = await twoOrgs();
    await expect(
      startSubscription(
        corp.userId,
        corp.organisationId,
        'starter',
        new FakePaymentProvider(),
        RETURN_URL,
        testDb,
      ),
    ).rejects.toBeInstanceOf(InvalidStateError);
  });

  it('refuses an unknown plan', async () => {
    const { corp } = await twoOrgs();
    await expect(
      startSubscription(
        corp.userId,
        corp.organisationId,
        'platinum',
        new FakePaymentProvider(),
        RETURN_URL,
        testDb,
      ),
    ).rejects.toBeInstanceOf(NotFoundError);
  });

  it('refuses a non-member, and a member who is not a CSR manager', async () => {
    const { corp, charity } = await twoOrgs();
    const provider = new FakePaymentProvider();

    await expect(
      startSubscription(charity.userId, corp.organisationId, 'team', provider, RETURN_URL, testDb),
    ).rejects.toBeInstanceOf(NotFoundError);

    const { userId: volunteer } = await inviteMember(
      corp.userId,
      corp.organisationId,
      'dana@acme.com',
      'volunteer',
      testDb,
    );
    await expect(
      startSubscription(volunteer, corp.organisationId, 'team', provider, RETURN_URL, testDb),
    ).rejects.toBeInstanceOf(ForbiddenError);
  });
});

describe('callback signatures (US-10.6)', () => {
  it('an unsigned or forged body cannot confirm a checkout', async () => {
    const { corp } = await twoOrgs();
    const provider = new FakePaymentProvider();
    const checkout = await startSubscription(
      corp.userId,
      corp.organisationId,
      'team',
      provider,
      RETURN_URL,
      testDb,
    );
    const body = JSON.stringify({ type: 'checkout.completed', checkoutId: checkout.checkoutId });

    expect(await provider.verifyCheckoutCallback(body, null)).toBeNull();
    expect(await provider.verifyCheckoutCallback(body, 'not-the-signature')).toBeNull();
    // Only a correctly signed body confirms — so no forged upgrade is possible.
    expect(
      await provider.verifyCheckoutCallback(body, FakePaymentProvider.sign(body)),
    ).not.toBeNull();
  });

  it('ignores a signed body carrying a malformed checkout id', async () => {
    const provider = new FakePaymentProvider();
    const body = JSON.stringify({ type: 'checkout.completed', checkoutId: 'not-a-checkout' });
    expect(await provider.verifyCheckoutCallback(body, FakePaymentProvider.sign(body))).toBeNull();
  });
});
