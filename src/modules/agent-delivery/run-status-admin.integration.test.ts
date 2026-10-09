import { describe, it, expect } from 'vitest';
import { eq } from 'drizzle-orm';
import { testDb } from '@/test/db';
import { auditLog, outbox } from '@/db/schema';
import { ForbiddenError } from '@/modules/identity';
import { authorisedRun } from '@/test/agent-delivery-fixtures';
import { setRunStatus, runStatusSchema } from '.';

describe('setRunStatus admin audit + event payload', () => {
  it('writes an audit-log entry naming the actor and the transition', async () => {
    const { admin, runId } = await authorisedRun();
    await setRunStatus(admin, runId, 'paused', testDb);

    const audits = await testDb
      .select()
      .from(auditLog)
      .where(eq(auditLog.action, 'agent_delivery.run.paused'));
    expect(audits).toHaveLength(1);
    expect(audits[0]!.actorId).toBe(admin);
    expect(audits[0]!.entity).toBe('agent_delivery_run');
    expect(audits[0]!.entityId).toBe(runId);
    expect((audits[0]!.metadata as Record<string, unknown>).previousStatus).toBe('authorized');
  });

  it('emits RunStatusChanged carrying both parties so notifications can route', async () => {
    const { admin, charity, corp, runId } = await authorisedRun();
    await setRunStatus(admin, runId, 'paused', testDb);

    const events = await testDb
      .select()
      .from(outbox)
      .where(eq(outbox.eventType, 'RunStatusChanged'));
    expect(events).toHaveLength(1);
    const payload = events[0]!.payload as Record<string, unknown>;
    expect(payload.runId).toBe(runId);
    expect(payload.status).toBe('paused');
    expect(payload.charityOrgId).toBe(charity.organisationId);
    expect(payload.corporationOrgId).toBe(corp.organisationId);
  });

  it('refuses a non-admin without writing an audit entry', async () => {
    const { charity, runId } = await authorisedRun();
    await expect(setRunStatus(charity.userId, runId, 'halted', testDb)).rejects.toBeInstanceOf(
      ForbiddenError,
    );
    const audits = await testDb.select().from(auditLog);
    expect(audits).toHaveLength(0);
  });

  it('accepts only the three admin-settable statuses', () => {
    expect(runStatusSchema.parse({ status: 'paused' }).status).toBe('paused');
    expect(runStatusSchema.parse({ status: 'running' }).status).toBe('running');
    expect(runStatusSchema.parse({ status: 'halted' }).status).toBe('halted');
    expect(() => runStatusSchema.parse({ status: 'completed' })).toThrow();
    expect(() => runStatusSchema.parse({})).toThrow();
  });
});
