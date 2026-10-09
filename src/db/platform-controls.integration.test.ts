import { describe, it, expect } from 'vitest';
import { testDb } from '@/test/db';
import { platformControls, PLATFORM_CONTROLS_ID } from '@/db/schema';

describe('platform_controls singleton table', () => {
  it('is empty after a reset — an absent row is the default state', async () => {
    const rows = await testDb.select().from(platformControls);
    expect(rows).toHaveLength(0);
  });

  it('accepts the fixed singleton id and defaults the brake to off', async () => {
    await testDb.insert(platformControls).values({ id: PLATFORM_CONTROLS_ID });
    const rows = await testDb.select().from(platformControls);
    expect(rows).toHaveLength(1);
    expect(rows[0]!.agentDeliveryPaused).toBe(false);
  });

  it('rejects any other id, so a second row can never exist', async () => {
    await expect(
      testDb.insert(platformControls).values({ id: '00000000-0000-0000-0000-000000000002' }),
    ).rejects.toThrow();
  });
});
