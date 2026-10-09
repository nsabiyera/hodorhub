import { describe, it, expect } from 'vitest';
import { eq } from 'drizzle-orm';
import { testDb } from '@/test/db';
import { notifications } from '@/db/schema';
import { FakeDeployer } from '@/lib/fake-deployer';
import { relayOutbox } from '@/modules/notifications/relay';
import { dispatchEvent } from '@/modules/notifications/service';
import { twoOrgs, promotableRun } from '@/test/agent-delivery-fixtures';
import { requestProductionPromotion, runProductionPromotion } from './promotion';

describe('promotion wiring: relay hook (US-11.8)', () => {
  it('hands a promotion request to the worker hook, not the run-advance hook', async () => {
    const { charity, runId } = await promotableRun();
    const { promotionId } = await requestProductionPromotion(charity.userId, runId, testDb);

    const advanced: string[] = [];
    const promoted: string[] = [];
    await relayOutbox(
      testDb,
      100,
      (id) => advanced.push(id),
      (id) => promoted.push(id),
    );

    expect(promoted).toContain(promotionId);
    // The promotion must never look like a run advance to the agent path.
    expect(advanced).not.toContain(promotionId);
  });
});

describe('promotion wiring: notifications (US-11.8)', () => {
  it('tells both parties when the app goes live in production', async () => {
    const { charity, corp } = await twoOrgs();
    await dispatchEvent(testDb, {
      eventType: 'ProductionPromoted',
      payload: {
        promotionId: 'promotion-1',
        runId: 'run-1',
        url: 'https://live.example.org',
        by: charity.userId,
        charityOrgId: charity.organisationId,
        corporationOrgId: corp.organisationId,
      },
    });

    const rows = await testDb
      .select()
      .from(notifications)
      .where(eq(notifications.type, 'agent_run.promoted'));
    expect(rows).toHaveLength(2);
    expect(rows.map((r) => r.userId).sort()).toEqual([charity.userId, corp.userId].sort());
  });

  it('says nothing until the deploy has actually succeeded', async () => {
    const { charity, runId } = await promotableRun();
    await requestProductionPromotion(charity.userId, runId, testDb);
    await relayOutbox(testDb, 100);

    const beforeDeploy = await testDb
      .select()
      .from(notifications)
      .where(eq(notifications.type, 'agent_run.promoted'));
    expect(beforeDeploy).toHaveLength(0);
  });

  it('notifies once the privileged deployer has promoted it', async () => {
    const { charity, runId } = await promotableRun();
    const { promotionId } = await requestProductionPromotion(charity.userId, runId, testDb);
    await runProductionPromotion(promotionId, new FakeDeployer(), testDb);
    await relayOutbox(testDb, 100);

    const rows = await testDb
      .select()
      .from(notifications)
      .where(eq(notifications.type, 'agent_run.promoted'));
    expect(rows).toHaveLength(2);
  });
});
