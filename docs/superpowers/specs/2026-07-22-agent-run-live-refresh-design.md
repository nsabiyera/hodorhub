# Agent-Delivery Run Panel — Live Auto-Refresh Design

**Date:** 2026-07-22
**Status:** Approved (brainstorming)
**Scope:** Frontend only. Make the agent-delivery `AgentRunPanel` update itself as the worker advances a run, so a viewer no longer has to manually reload to watch phases progress.

## Problem

The agent-delivery flow is already fully wired to the frontend: `src/app/projects/[id]/page.tsx` fetches the run via `getRunForProject` and renders `AgentRunPanel` (status, 4-phase timeline, budget, staging URL) plus the corp `FundAgentDeliveryForm`, charity `ComputePledgeActions`, and `MilestoneGateActions`. Every control POSTs to the real API and then calls `window.location.reload()`.

The gap: the run advances **asynchronously** in the worker (the outbox relay polls every ~3s and enqueues `agent.advance`), but the panel is a static SSR snapshot. After a user approves a gate the page reloads once, then the next phase's progress only appears on a further manual refresh. There is no live-refresh mechanism anywhere under `src/app/projects` (confirmed: no `setInterval`, `EventSource`, `useSWR`, or `router.refresh`).

## Approach (chosen: A — `router.refresh()` poller)

While the run is non-terminal, a small client component calls Next's `router.refresh()` on an interval. That re-runs the existing `force-dynamic` server component (re-fetching `getRunForProject` and the rest of the page) and reconciles the RSC payload in place — no full reload, no lost scroll/state, no new endpoint.

Alternatives considered and rejected:
- **B — dedicated `GET /api/projects/[id]/run` + client fetch:** updates only the panel but adds a second render path (duplicates panel logic or the read model) and a new endpoint to test/maintain, for marginal benefit.
- **C — server push (SSE/WebSocket):** truly instant but needs a streaming endpoint + subscription infra; overkill for a run that changes every few seconds and mostly sits at human gates (YAGNI).

Approach A is the smallest change, is idiomatic App Router, and rides the exact read path already exercised end-to-end.

## Components

### 1. `src/modules/agent-delivery/run-status.ts` — single source of truth
A pure, framework-free helper in the module that owns the concept:

```ts
export const RUN_TERMINAL_STATUSES = ['completed', 'failed', 'halted'] as const;

/** A run is "active" (still progressing / not settled) unless it is terminal. */
export function isRunActive(status: string): boolean {
  return !RUN_TERMINAL_STATUSES.includes(status as (typeof RUN_TERMINAL_STATUSES)[number]);
}
```

- Terminal set matches the run-status enum `agentRunStatus` (schema) and the existing inline check at `service.ts:200`.
- Active statuses are therefore: `authorized`, `running`, `awaiting_gate`, `paused`.
- Exported from `src/modules/agent-delivery/index.ts` for reuse.

**Targeted cleanup (related, in-scope):** replace the inline
`run.status === 'completed' || run.status === 'failed' || run.status === 'halted'`
at `service.ts:200` with `!isRunActive(run.status)` (or `RUN_TERMINAL_STATUSES.includes(...)`), so the terminal-status definition lives in exactly one place. No other refactoring.

### 2. `src/app/projects/[id]/RunLivePoller.tsx` — client timer shell (`'use client'`)
- **Prop:** `active: boolean` — the page computes it via `isRunActive(run.status)` and passes it in, keeping this component a dumb timer shell (mirrors how `ComputePledgeActions` / `MilestoneGateActions` stay thin).
- **Behavior:** while `active`, a `useEffect` sets a `setInterval` calling `router.refresh()` (`next/navigation`) every **4000 ms**. The interval is cleared on unmount and whenever `active` becomes false (effect dependency on `active`).
- **Good-citizen behavior:** while the tab is hidden (`document.hidden`), the tick skips `router.refresh()`; a `visibilitychange` listener lets it resume when the tab is visible again. (Skip-on-hidden keeps the timer logic trivial and avoids background network churn.)
- **Render:** a subtle inline indicator — `● Live — updating automatically` — while `active`; renders nothing when inactive.

### 3. Wiring
`AgentRunPanel` renders `<RunLivePoller active={isRunActive(run.status)} />` beside the status chip in the `run-status` row. Because the server component is `force-dynamic`, each `router.refresh()` re-runs `getRunForProject`, so the phase timeline, budget line, deployed staging URL, and page-level project/pledge state all update in place.

## Data flow

```
worker advances run (async, ~3s relay)
        │
        ▼
RunLivePoller tick (every 4s, tab visible)
  → router.refresh()
        │
        ▼
server component re-runs getRunForProject (force-dynamic)
        │
        ▼
RSC payload reconciles → AgentRunPanel shows new phase / budget / deploy URL
        │
        ▼
run reaches terminal status → active=false → interval cleared → polling stops
```

## Error handling

`router.refresh()` failures are transient and self-correcting — the next tick retries — so no error UI is introduced. The component adds no user input, so there is no new validation surface.

## Testing

- **`run-status.ts`:** real unit tests in `src/modules/agent-delivery/run-status.test.ts` (node-env `.test.ts`, same pattern as `budget-math.test.ts`): each terminal status → `isRunActive` false; each active status (`authorized`, `running`, `awaiting_gate`, `paused`) → true; `RUN_TERMINAL_STATUSES` matches the terminal enum members.
- **`service.ts` cleanup:** covered by the existing agent-delivery integration tests (the terminal-status branch is already exercised); behavior is unchanged.
- **`RunLivePoller`:** follows the project's established convention for `'use client'` components — not unit-tested (vitest is node-env, `.test.ts` only, no jsdom/testing-library; existing action components carry no tests). Verified in the running app: fund → accept → approve each gate and watch the panel advance through requirements → design → build → delivery → completed with no manual refresh, and confirm polling stops once the run completes.

## Non-goals

- No change to the API, worker, orchestrator, budget, or DB schema.
- No server-push/streaming infrastructure.
- No new run controls or data in the panel (this is purely making the existing panel live).
- No unrelated refactoring beyond the one `service.ts:200` dedup.
