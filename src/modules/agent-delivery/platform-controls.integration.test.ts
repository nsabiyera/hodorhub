import { describe, it, expect } from 'vitest';
import { eq } from 'drizzle-orm';
import { testDb } from '@/test/db';
import { auditLog, outbox, platformControls } from '@/db/schema';
import { createPlatformAdmin, registerCharity, ForbiddenError } from '@/modules/identity';
import { isAgentDeliveryPaused, setAgentDeliveryPaused } from './platform-controls';

describe('agent-delivery platform brake', () => {
  it('reads as not paused when no row exists', async () => {
    expect(await isAgentDeliveryPaused(testDb)).toBe(false);
  });

  it('an admin pulls the brake, and it reads back as paused', async () => {
    const admin = await createPlatformAdmin('admin@hh.com', 'admin-password-1', testDb);
    await setAgentDeliveryPaused(admin, true, testDb);
    expect(await isAgentDeliveryPaused(testDb)).toBe(true);
  });

  it('an admin releases the brake again', async () => {
    const admin = await createPlatformAdmin('admin@hh.com', 'admin-password-1', testDb);
    await setAgentDeliveryPaused(admin, true, testDb);
    await setAgentDeliveryPaused(admin, false, testDb);
    expect(await isAgentDeliveryPaused(testDb)).toBe(false);
  });

  it('pulling the brake twice upserts rather than erroring, leaving one row', async () => {
    const admin = await createPlatformAdmin('admin@hh.com', 'admin-password-1', testDb);
    await setAgentDeliveryPaused(admin, true, testDb);
    await setAgentDeliveryPaused(admin, true, testDb);
    const rows = await testDb.select().from(platformControls);
    expect(rows).toHaveLength(1);
    expect(rows[0]!.updatedBy).toBe(admin);
  });

  it('refuses a non-admin', async () => {
    const charity = await registerCharity(
      {
        email: 'petra@goodcause.org',
        password: 'a-strong-password',
        charityName: 'Good Cause',
        regNumber: 'CH-1',
      },
      testDb,
    );
    await expect(setAgentDeliveryPaused(charity.userId, true, testDb)).rejects.toBeInstanceOf(
      ForbiddenError,
    );
    expect(await isAgentDeliveryPaused(testDb)).toBe(false);
  });

  it('writes an audit-log entry and an outbox event for each change', async () => {
    const admin = await createPlatformAdmin('admin@hh.com', 'admin-password-1', testDb);
    await setAgentDeliveryPaused(admin, true, testDb);

    const audits = await testDb
      .select()
      .from(auditLog)
      .where(eq(auditLog.action, 'agent_delivery.brake.pulled'));
    expect(audits).toHaveLength(1);
    expect(audits[0]!.actorId).toBe(admin);
    expect(audits[0]!.entity).toBe('platform_controls');

    const events = await testDb
      .select()
      .from(outbox)
      .where(eq(outbox.eventType, 'PlatformBrakeChanged'));
    expect(events).toHaveLength(1);
    expect((events[0]!.payload as Record<string, unknown>).agentDeliveryPaused).toBe(true);
  });
});
