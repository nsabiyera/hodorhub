import { describe, it, expect } from 'vitest';
import { and, eq } from 'drizzle-orm';
import { testDb } from '@/test/db';
import { auditLog, deployedEnvironments, outbox } from '@/db/schema';
import { FakeDeployer } from '@/lib/fake-deployer';
import { InvalidStateError, NotFoundError } from '@/modules/identity';
import { authorisedRun, promotableRun } from '@/test/agent-delivery-fixtures';
import { requestProductionPromotion, runProductionPromotion } from './promotion';

const productionRows = (runId: string) =>
  testDb
    .select()
    .from(deployedEnvironments)
    .where(
      and(
        eq(deployedEnvironments.runId, runId),
        eq(deployedEnvironments.environment, 'production'),
      ),
    );

describe('requestProductionPromotion (US-11.8)', () => {
  it('records an explicit promotion request without deploying anything', async () => {
    const { charity, runId, deployer } = await promotableRun();
    const deployCallsBefore = deployer.calls.length;

    const { promotionId } = await requestProductionPromotion(charity.userId, runId, testDb);

    const rows = await productionRows(runId);
    expect(rows).toHaveLength(1);
    expect(rows[0]!.id).toBe(promotionId);
    expect(rows[0]!.status).toBe('deploying');
    expect(rows[0]!.promotedBy).toBe(charity.userId);
    expect(rows[0]!.url).toBeNull();
    // The request is intent only - the privileged deployer acts later.
    expect(deployer.calls).toHaveLength(deployCallsBefore);
  });

  it('writes an audit entry and an event carrying both parties', async () => {
    const { charity, corp, runId } = await promotableRun();
    const { promotionId } = await requestProductionPromotion(charity.userId, runId, testDb);

    const audits = await testDb
      .select()
      .from(auditLog)
      .where(eq(auditLog.action, 'agent_delivery.promotion.requested'));
    expect(audits).toHaveLength(1);
    expect(audits[0]!.actorId).toBe(charity.userId);
    expect(audits[0]!.entity).toBe('agent_delivery_run');
    expect(audits[0]!.entityId).toBe(runId);

    const events = await testDb
      .select()
      .from(outbox)
      .where(eq(outbox.eventType, 'ProductionPromotionRequested'));
    expect(events).toHaveLength(1);
    const payload = events[0]!.payload as Record<string, unknown>;
    expect(payload.promotionId).toBe(promotionId);
    expect(payload.runId).toBe(runId);
    expect(payload.charityOrgId).toBe(charity.organisationId);
    expect(payload.corporationOrgId).toBe(corp.organisationId);
  });

  it('refuses a run whose delivery phase is not approved yet', async () => {
    const { charity, runId } = await authorisedRun();
    await expect(requestProductionPromotion(charity.userId, runId, testDb)).rejects.toBeInstanceOf(
      InvalidStateError,
    );
    expect(await productionRows(runId)).toHaveLength(0);
  });

  it('refuses a second request while one is already in flight', async () => {
    const { charity, runId } = await promotableRun();
    await requestProductionPromotion(charity.userId, runId, testDb);
    await expect(requestProductionPromotion(charity.userId, runId, testDb)).rejects.toBeInstanceOf(
      InvalidStateError,
    );
    expect(await productionRows(runId)).toHaveLength(1);
  });

  it('refuses a re-promote once production is already live', async () => {
    const { charity, runId } = await promotableRun();
    const { promotionId } = await requestProductionPromotion(charity.userId, runId, testDb);
    await runProductionPromotion(promotionId, new FakeDeployer(), testDb);
    await expect(requestProductionPromotion(charity.userId, runId, testDb)).rejects.toBeInstanceOf(
      InvalidStateError,
    );
  });

  it('refuses the corporation that funded the run - promotion is the charity call', async () => {
    const { corp, runId } = await promotableRun();
    await expect(requestProductionPromotion(corp.userId, runId, testDb)).rejects.toBeInstanceOf(
      NotFoundError,
    );
  });

  it('refuses a platform admin - the story gives this to the charity alone', async () => {
    const { admin, runId } = await promotableRun();
    await expect(requestProductionPromotion(admin, runId, testDb)).rejects.toBeInstanceOf(
      NotFoundError,
    );
  });

  it('refuses an unknown run', async () => {
    const { charity } = await promotableRun();
    await expect(
      requestProductionPromotion(charity.userId, '11111111-1111-1111-1111-111111111111', testDb),
    ).rejects.toBeInstanceOf(NotFoundError);
  });
});

describe('runProductionPromotion (US-11.8)', () => {
  it('deploys the approved build artifact to production and records the url', async () => {
    const { charity, runId } = await promotableRun();
    const { promotionId } = await requestProductionPromotion(charity.userId, runId, testDb);
    const deployer = new FakeDeployer({ url: 'https://live.example.org', revisionRef: 'rev-9' });

    const result = await runProductionPromotion(promotionId, deployer, testDb);

    expect(result.status).toBe('live');
    expect(deployer.calls).toHaveLength(1);
    expect(deployer.calls[0]!.environment).toBe('production');
    expect(deployer.calls[0]!.runId).toBe(runId);
    const rows = await productionRows(runId);
    expect(rows[0]!.status).toBe('live');
    expect(rows[0]!.url).toBe('https://live.example.org');
    expect(rows[0]!.revisionRef).toBe('rev-9');
    expect(rows[0]!.deployedAt).not.toBeNull();
  });

  it('promotes the same artifact the charity approved, never a fresh build', async () => {
    const { charity, runId } = await promotableRun();
    const { promotionId } = await requestProductionPromotion(charity.userId, runId, testDb);
    const deployer = new FakeDeployer();

    await runProductionPromotion(promotionId, deployer, testDb);

    const build = await testDb.query.runMilestones.findFirst({
      where: (m, { and: a, eq: e }) => a(e(m.runId, runId), e(m.phase, 'build')),
    });
    expect(deployer.calls[0]!.artifactRef).toBe(build!.artifactRef);
  });

  it('writes an audit entry and an event naming the promoter', async () => {
    const { charity, runId } = await promotableRun();
    const { promotionId } = await requestProductionPromotion(charity.userId, runId, testDb);
    await runProductionPromotion(promotionId, new FakeDeployer(), testDb);

    const audits = await testDb
      .select()
      .from(auditLog)
      .where(eq(auditLog.action, 'agent_delivery.promotion.deployed'));
    expect(audits).toHaveLength(1);
    expect(audits[0]!.actorId).toBe(charity.userId);

    const events = await testDb
      .select()
      .from(outbox)
      .where(eq(outbox.eventType, 'ProductionPromoted'));
    expect(events).toHaveLength(1);
    expect((events[0]!.payload as Record<string, unknown>).url).toBeTruthy();
  });

  it('is idempotent under a retry - a second call skips rather than deploying twice', async () => {
    const { charity, runId } = await promotableRun();
    const { promotionId } = await requestProductionPromotion(charity.userId, runId, testDb);
    const deployer = new FakeDeployer();

    await runProductionPromotion(promotionId, deployer, testDb);
    const second = await runProductionPromotion(promotionId, deployer, testDb);

    expect(second.status).toBe('skipped');
    expect(deployer.calls).toHaveLength(1);
    expect(await productionRows(runId)).toHaveLength(1);
  });

  it('marks the row failed and rethrows when the deploy fails, leaving a fresh request possible', async () => {
    const { charity, runId } = await promotableRun();
    const { promotionId } = await requestProductionPromotion(charity.userId, runId, testDb);
    const exploding = {
      deploy: async () => {
        throw new Error('deployer exploded');
      },
    };

    await expect(runProductionPromotion(promotionId, exploding, testDb)).rejects.toThrow(
      'deployer exploded',
    );
    const rows = await productionRows(runId);
    expect(rows[0]!.status).toBe('failed');

    // A failed promotion does not lock the run out of trying again.
    const retry = await requestProductionPromotion(charity.userId, runId, testDb);
    expect(retry.promotionId).not.toBe(promotionId);
  });
});
