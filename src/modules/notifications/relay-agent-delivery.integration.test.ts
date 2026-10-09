import { describe, it, expect, vi } from 'vitest';
import { eq } from 'drizzle-orm';
import { testDb } from '@/test/db';
import { outbox } from '@/db/schema';
import { relayOutbox } from './relay';

/**
 * Slice 3a Task 6: the relay additionally invokes an injected
 * `onAgentDeliveryEvent(runId)` callback for the runnable-making
 * agent-delivery events, so a pg-boss worker can enqueue `agent.advance`.
 * Notifications dispatch (relay.integration.test.ts) is unaffected.
 */
describe('outbox relay — agent-delivery subscriber hook', () => {
  it('invokes onAgentDeliveryEvent(runId) for a MilestoneApproved event and marks it published', async () => {
    const runId = '11111111-1111-1111-1111-111111111111';
    const [row] = await testDb
      .insert(outbox)
      .values({
        eventType: 'MilestoneApproved',
        payload: { milestoneId: 'm-1', runId, phase: 'requirements' },
      })
      .returning({ id: outbox.id });

    const onAgentDeliveryEvent = vi.fn();
    const processed = await relayOutbox(testDb, 100, onAgentDeliveryEvent);

    expect(processed).toBe(1);
    expect(onAgentDeliveryEvent).toHaveBeenCalledTimes(1);
    expect(onAgentDeliveryEvent).toHaveBeenCalledWith(runId);

    const after = await testDb.query.outbox.findFirst({ where: eq(outbox.id, row!.id) });
    expect(after!.published).toBe(true);
  });

  it('does not invoke the callback for events that are not runnable-making', async () => {
    await testDb
      .insert(outbox)
      .values({ eventType: 'ProjectPublished', payload: { projectId: 'p-1' } });

    const onAgentDeliveryEvent = vi.fn();
    const processed = await relayOutbox(testDb, 100, onAgentDeliveryEvent);

    expect(processed).toBe(1);
    expect(onAgentDeliveryEvent).not.toHaveBeenCalled();
  });

  it('defaults to a no-op when no callback is supplied', async () => {
    const runId = '22222222-2222-2222-2222-222222222222';
    await testDb.insert(outbox).values({
      eventType: 'RunStatusChanged',
      payload: { runId, status: 'paused', by: 'admin-1' },
    });

    await expect(relayOutbox(testDb)).resolves.toBe(1);
  });
});
