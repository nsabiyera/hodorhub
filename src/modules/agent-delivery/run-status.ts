/**
 * Single source of truth for whether an agent-delivery run is still moving.
 * Terminal statuses match the `agentRunStatus` enum (src/db/schema.ts) and the
 * settled-run check in service.ts. Used by the run-panel live poller (UI) to
 * decide whether to keep auto-refreshing.
 */
export const RUN_TERMINAL_STATUSES = ['completed', 'failed', 'halted'] as const;

export type RunTerminalStatus = (typeof RUN_TERMINAL_STATUSES)[number];

/** A run is "active" (still progressing / not settled) unless it is terminal. */
export function isRunActive(status: string): boolean {
  return !RUN_TERMINAL_STATUSES.includes(status as RunTerminalStatus);
}
