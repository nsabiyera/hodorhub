import { describe, it, expect } from 'vitest';
import { eq } from 'drizzle-orm';
import { testDb } from '@/test/db';
import { notifications } from '@/db/schema';
import { twoOrgs } from '@/test/agent-delivery-fixtures';
import { dispatchEvent } from './service';

describe('RunStatusChanged notifications', () => {
  it('notifies the charity owner and the CSR manager when a run is halted', async () => {
    const { charity, corp } = await twoOrgs();
    await dispatchEvent(testDb, {
      eventType: 'RunStatusChanged',
      payload: {
        runId: 'run-1',
        status: 'halted',
        by: 'admin-1',
        charityOrgId: charity.organisationId,
        corporationOrgId: corp.organisationId,
      },
    });

    const rows = await testDb
      .select()
      .from(notifications)
      .where(eq(notifications.type, 'agent_run.halted'));
    expect(rows).toHaveLength(2);
    expect(rows.map((r) => r.userId).sort()).toEqual([charity.userId, corp.userId].sort());
  });

  it('uses a distinct type for paused and resumed', async () => {
    const { charity, corp } = await twoOrgs();
    const base = {
      runId: 'run-1',
      by: 'admin-1',
      charityOrgId: charity.organisationId,
      corporationOrgId: corp.organisationId,
    };
    await dispatchEvent(testDb, {
      eventType: 'RunStatusChanged',
      payload: { ...base, status: 'paused' },
    });
    await dispatchEvent(testDb, {
      eventType: 'RunStatusChanged',
      payload: { ...base, status: 'running' },
    });

    const paused = await testDb
      .select()
      .from(notifications)
      .where(eq(notifications.type, 'agent_run.paused'));
    const resumed = await testDb
      .select()
      .from(notifications)
      .where(eq(notifications.type, 'agent_run.resumed'));
    expect(paused).toHaveLength(2);
    expect(resumed).toHaveLength(2);
  });
});
