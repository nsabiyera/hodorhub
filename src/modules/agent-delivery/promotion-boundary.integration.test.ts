import { describe, it, expect } from 'vitest';
import { and, eq } from 'drizzle-orm';
import { testDb } from '@/test/db';
import { deployedEnvironments } from '@/db/schema';
import { FakeModelProvider } from '@/lib/fake-model-provider';
import { FakeSandboxRunner } from '@/lib/fake-sandbox-runner';
import { FakeDeployer } from '@/lib/fake-deployer';
import { authorisedRun } from '@/test/agent-delivery-fixtures';
import { advanceRun } from './dispatcher';
import { approveMilestone } from './service';

/**
 * US-11.8, behavioural half: drive a whole run the way the worker does — every
 * phase through advanceRun, every gate approved — and assert the agents never
 * reached production. The structural guards live in promotion-boundary.test.ts.
 */
describe('the agents never promote to production (US-11.8)', () => {
  it('deploys only to staging across a complete run, and creates no production environment', async () => {
    const { charity, runId } = await authorisedRun();
    const provider = new FakeModelProvider([
      { text: 'criteria' },
      { text: 'design' },
      { text: 'code' },
    ]);
    const deps = { sandbox: new FakeSandboxRunner(), deployer: new FakeDeployer() };

    // Four phases: advance, then approve the gate it opened, until the run ends.
    for (let i = 0; i < 4; i++) {
      const result = await advanceRun(runId, provider, testDb, deps);
      expect(result.ran).toBe(true);
      const milestone = await testDb.query.runMilestones.findFirst({
        where: (m, { and: a, eq: e }) => a(e(m.runId, runId), e(m.status, 'awaiting_review')),
      });
      await approveMilestone(charity.userId, milestone!.id, testDb);
    }

    const run = await testDb.query.agentDeliveryRuns.findFirst({
      where: (r, { eq: e }) => e(r.id, runId),
    });
    expect(run!.status).toBe('completed');

    // The whole point: every deploy the agent path issued was staging.
    expect(deps.deployer.calls.length).toBeGreaterThan(0);
    for (const call of deps.deployer.calls) {
      expect(call.environment).toBe('staging');
    }
    const production = await testDb
      .select()
      .from(deployedEnvironments)
      .where(
        and(
          eq(deployedEnvironments.runId, runId),
          eq(deployedEnvironments.environment, 'production'),
        ),
      );
    expect(production).toHaveLength(0);
  });

  it('a re-run after changes-requested still never touches production', async () => {
    const { charity, runId } = await authorisedRun();
    const provider = new FakeModelProvider([
      { text: 'criteria' },
      { text: 'criteria again' },
      { text: 'design' },
    ]);
    const deps = { sandbox: new FakeSandboxRunner(), deployer: new FakeDeployer() };

    await advanceRun(runId, provider, testDb, deps);
    const first = await testDb.query.runMilestones.findFirst({
      where: (m, { and: a, eq: e }) => a(e(m.runId, runId), e(m.status, 'awaiting_review')),
    });
    const { requestChanges } = await import('./service');
    await requestChanges(charity.userId, first!.id, 'not quite', testDb);
    await advanceRun(runId, provider, testDb, deps);

    for (const call of deps.deployer.calls) {
      expect(call.environment).toBe('staging');
    }
  });
});
