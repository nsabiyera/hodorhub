import { describe, it, expect } from 'vitest';
import { isRunActive, RUN_TERMINAL_STATUSES } from './run-status';

describe('isRunActive', () => {
  it.each(['authorized', 'running', 'awaiting_gate', 'paused'])(
    'treats non-terminal status %s as active',
    (status) => {
      expect(isRunActive(status)).toBe(true);
    },
  );

  it.each(['completed', 'failed', 'halted'])('treats terminal status %s as inactive', (status) => {
    expect(isRunActive(status)).toBe(false);
  });

  it('treats an unknown status as active (fail open: keep polling rather than freeze a live run)', () => {
    expect(isRunActive('some_future_status')).toBe(true);
  });

  it('RUN_TERMINAL_STATUSES is exactly the three settled statuses', () => {
    expect([...RUN_TERMINAL_STATUSES]).toEqual(['completed', 'failed', 'halted']);
  });
});
