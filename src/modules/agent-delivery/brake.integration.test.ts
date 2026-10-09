import { describe, it, expect } from 'vitest';
import { eq } from 'drizzle-orm';
import { testDb } from '@/test/db';
import { runMilestones } from '@/db/schema';
import { FakeModelProvider } from '@/lib/fake-model-provider';
import { authorisedRun } from '@/test/agent-delivery-fixtures';
import { advanceRun } from './dispatcher';
import { setAgentDeliveryPaused } from './platform-controls';

describe('platform brake blocks every run advance', () => {
  it('does not advance a runnable run while the brake is engaged', async () => {
    const { admin, runId } = await authorisedRun();
    await setAgentDeliveryPaused(admin, true, testDb);

    const provider = new FakeModelProvider([{ text: 'criteria' }]);
    const result = await advanceRun(runId, provider, testDb);

    expect(result.ran).toBe(false);
    expect(result.status).toBe('authorized');
    expect(result.phase).toBe('requirements');
    const milestones = await testDb
      .select()
      .from(runMilestones)
      .where(eq(runMilestones.runId, runId));
    expect(milestones).toHaveLength(0);
  });

  it('advances again once the brake is released', async () => {
    const { admin, runId } = await authorisedRun();
    await setAgentDeliveryPaused(admin, true, testDb);
    const provider = new FakeModelProvider([{ text: 'criteria' }]);
    await advanceRun(runId, provider, testDb);

    await setAgentDeliveryPaused(admin, false, testDb);
    const result = await advanceRun(runId, provider, testDb);

    expect(result.ran).toBe(true);
    expect(result.status).toBe('awaiting_gate');
    const milestones = await testDb
      .select()
      .from(runMilestones)
      .where(eq(runMilestones.runId, runId));
    expect(milestones).toHaveLength(1);
  });
});
