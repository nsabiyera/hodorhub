import { describe, it, expect } from 'vitest';
import { FakeModelProvider } from '@/lib/fake-model-provider';
import { advanceRun } from './dispatcher';

/**
 * The brake must never fail open: if the platform_controls read throws, the
 * advance must fail (the pg-boss job then retries) rather than proceed as if
 * the brake were off. No database needed — a stub executor is enough.
 */
describe('advanceRun brake fail-safe', () => {
  it('propagates a platform_controls read error instead of advancing', async () => {
    const stubDb = {
      query: {
        agentDeliveryRuns: {
          findFirst: async () => ({
            id: 'run-1',
            status: 'authorized',
            currentPhase: 'requirements',
          }),
        },
        platformControls: {
          findFirst: async () => {
            throw new Error('platform_controls unavailable');
          },
        },
      },
    } as unknown as Parameters<typeof advanceRun>[2];

    await expect(
      advanceRun('run-1', new FakeModelProvider([{ text: 'criteria' }]), stubDb),
    ).rejects.toThrow('platform_controls unavailable');
  });
});
