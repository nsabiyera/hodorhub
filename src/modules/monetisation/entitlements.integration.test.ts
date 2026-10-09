import { describe, it, expect } from 'vitest';
import { eq } from 'drizzle-orm';
import { testDb } from '@/test/db';
import { entitlements, plans, subscriptions } from '@/db/schema';
import { NotFoundError } from '@/modules/identity';
import { twoOrgs } from '@/test/agent-delivery-fixtures';
import { hasEntitlement, getPlanForOrg, getEntitlementSummary } from './service';
import { FEATURES } from './plans';

/** Put an organisation on a named plan, creating the catalogue row on demand. */
async function subscribe(organisationId: string, code: string, name: string) {
  const [plan] = await testDb.insert(plans).values({ code, name }).returning({ id: plans.id });
  await testDb.insert(subscriptions).values({ organisationId, planId: plan!.id, status: 'active' });
}

describe('plans and entitlements (US-10.1, US-10.2)', () => {
  it('a corporation with no subscription is on Starter, not planless', async () => {
    const { corp } = await twoOrgs();

    const plan = await getPlanForOrg(corp.organisationId, testDb);

    expect(plan.code).toBe('starter');
    // Nothing was written to get there — absent means default.
    expect(await testDb.select().from(subscriptions)).toHaveLength(0);
  });

  it('Starter does not include the paid features', async () => {
    const { corp } = await twoOrgs();

    expect(await hasEntitlement(corp.organisationId, FEATURES.csrDashboard, testDb)).toBe(false);
    expect(await hasEntitlement(corp.organisationId, FEATURES.branding, testDb)).toBe(false);
    expect(await hasEntitlement(corp.organisationId, FEATURES.customDomain, testDb)).toBe(false);
  });

  it('Team unlocks the dashboard and branding but not custom domains', async () => {
    const { corp } = await twoOrgs();
    await subscribe(corp.organisationId, 'team', 'Team');

    expect(await hasEntitlement(corp.organisationId, FEATURES.csrDashboard, testDb)).toBe(true);
    expect(await hasEntitlement(corp.organisationId, FEATURES.branding, testDb)).toBe(true);
    expect(await hasEntitlement(corp.organisationId, FEATURES.customDomain, testDb)).toBe(false);
  });

  it('Enterprise unlocks everything', async () => {
    const { corp } = await twoOrgs();
    await subscribe(corp.organisationId, 'enterprise', 'Enterprise');

    for (const feature of Object.values(FEATURES)) {
      expect(await hasEntitlement(corp.organisationId, feature, testDb)).toBe(true);
    }
  });

  it('a per-organisation grant unlocks a feature the plan does not include', async () => {
    const { corp } = await twoOrgs();
    // The US-10.8 seam: a complimentary or grant-funded account.
    await testDb
      .insert(entitlements)
      .values({ organisationId: corp.organisationId, feature: FEATURES.csrDashboard });

    expect(await hasEntitlement(corp.organisationId, FEATURES.csrDashboard, testDb)).toBe(true);
    // Still on Starter — the grant is an override, not an upgrade.
    expect((await getPlanForOrg(corp.organisationId, testDb)).code).toBe('starter');
  });

  it('falls back to Starter rather than throwing when a plan code is unknown', async () => {
    const { corp } = await twoOrgs();
    await subscribe(corp.organisationId, 'retired-plan', 'Retired');

    // Losing a feature is recoverable; a 500 on every gated request is not.
    expect((await getPlanForOrg(corp.organisationId, testDb)).code).toBe('starter');
  });

  it('ignores a cancelled subscription', async () => {
    const { corp } = await twoOrgs();
    const [plan] = await testDb
      .insert(plans)
      .values({ code: 'team', name: 'Team' })
      .returning({ id: plans.id });
    await testDb.insert(subscriptions).values({
      organisationId: corp.organisationId,
      planId: plan!.id,
      status: 'cancelled',
    });

    expect((await getPlanForOrg(corp.organisationId, testDb)).code).toBe('starter');
    expect(await hasEntitlement(corp.organisationId, FEATURES.csrDashboard, testDb)).toBe(false);
  });

  it('refuses an unknown organisation', async () => {
    await expect(
      hasEntitlement('11111111-1111-1111-1111-111111111111', FEATURES.branding, testDb),
    ).rejects.toBeInstanceOf(NotFoundError);
  });

  it('summarises the plan and its features for an upgrade prompt', async () => {
    const { corp } = await twoOrgs();
    await subscribe(corp.organisationId, 'team', 'Team');

    const summary = await getEntitlementSummary(corp.organisationId, testDb);

    expect(summary.planCode).toBe('team');
    expect(summary.planName).toBe('Team');
    expect(summary.features).toContain(FEATURES.csrDashboard);
    expect(summary.features).not.toContain(FEATURES.customDomain);
    expect(summary.grantedFeatures).toEqual([]);
  });
});

describe('charities and supporters are never gated (US-10.3)', () => {
  it('a charity is entitled to every feature, on no plan at all', async () => {
    const { charity } = await twoOrgs();

    for (const feature of Object.values(FEATURES)) {
      expect(await hasEntitlement(charity.organisationId, feature, testDb)).toBe(true);
    }
    // And it never needed a subscription to be so.
    expect(await testDb.select().from(subscriptions)).toHaveLength(0);
  });

  it('stays entitled even if a cancelled subscription exists for it', async () => {
    const { charity } = await twoOrgs();
    const [plan] = await testDb
      .insert(plans)
      .values({ code: 'team', name: 'Team' })
      .returning({ id: plans.id });
    await testDb.insert(subscriptions).values({
      organisationId: charity.organisationId,
      planId: plan!.id,
      status: 'cancelled',
    });

    expect(await hasEntitlement(charity.organisationId, FEATURES.csrDashboard, testDb)).toBe(true);
  });

  it('no charity entitlement rows are needed to make that true', async () => {
    const { charity } = await twoOrgs();
    await hasEntitlement(charity.organisationId, FEATURES.branding, testDb);
    const rows = await testDb
      .select()
      .from(entitlements)
      .where(eq(entitlements.organisationId, charity.organisationId));
    expect(rows).toHaveLength(0);
  });
});
