# Agent-Delivery Run Panel — Live Auto-Refresh Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make the agent-delivery `AgentRunPanel` refresh itself while a run is still progressing, so a viewer watches phases advance without manually reloading.

**Architecture:** A pure `isRunActive(status)` helper (single source of truth for the terminal-status set) drives a thin `'use client'` timer component, `RunLivePoller`, which calls Next's `router.refresh()` every 4s while the run is active. `router.refresh()` re-runs the existing `force-dynamic` server component (`src/app/projects/[id]/page.tsx`), which re-fetches `getRunForProject` and reconciles the panel in place. No API, worker, orchestrator, or schema changes.

**Tech Stack:** TypeScript, Next.js 15 App Router (React Server Components + `next/navigation` `useRouter().refresh()`), Vitest (node-env unit tests, `.test.ts` only).

## Global Constraints

- **Node ≥ 20**, ESM, `@/` alias. Money = integer minor units (pence), GBP (not touched here).
- **Run-status terminal set is exactly `completed | failed | halted`** — matches the `agentRunStatus` enum (`src/db/schema.ts:79-87`) and the existing inline check at `src/modules/agent-delivery/service.ts:200`. Active statuses are therefore `authorized`, `running`, `awaiting_gate`, `paused`.
- **Client components are not unit-tested in this project** (Vitest is node-env, `include: ['src/**/*.{test,spec}.ts']`, no jsdom/testing-library). Existing action components (`ComputePledgeActions`, `MilestoneGateActions`, `GiftActions`) carry no tests. Put real logic in a pure `.ts` module that IS unit-tested; keep the React component a thin shell verified in the running app.
- **No new API endpoint, no worker/orchestrator/budget/schema change, no new run controls or data.** Purely make the existing panel live.
- **Poll interval = 4000 ms.** Pause ticks while `document.hidden`.
- **Follow existing client-component conventions** (`'use client'` at top; mirror the thin structure of `MilestoneGateActions.tsx`).

---

### Task 1: `isRunActive` helper + `service.ts` dedup

**Files:**
- Create: `src/modules/agent-delivery/run-status.ts`
- Create: `src/modules/agent-delivery/run-status.test.ts`
- Modify: `src/modules/agent-delivery/index.ts` (export the helper)
- Modify: `src/modules/agent-delivery/service.ts:200` (use the shared terminal set)

**Interfaces:**
- Consumes: nothing.
- Produces: `RUN_TERMINAL_STATUSES: readonly ['completed','failed','halted']` and `isRunActive(status: string): boolean` (false iff `status` is a terminal status). Exported from `@/modules/agent-delivery`.

- [ ] **Step 1: Write the failing test**

Create `src/modules/agent-delivery/run-status.test.ts`:
```ts
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
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npm run test -- src/modules/agent-delivery/run-status.test.ts`
Expected: FAIL — `Cannot find module './run-status'`.

- [ ] **Step 3: Write minimal implementation**

Create `src/modules/agent-delivery/run-status.ts`:
```ts
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
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npm run test -- src/modules/agent-delivery/run-status.test.ts`
Expected: PASS (7 assertions across the parameterized cases).

- [ ] **Step 5: Export from the module barrel**

In `src/modules/agent-delivery/index.ts`, add after the existing `getRunForProject` export line:
```ts
export { isRunActive, RUN_TERMINAL_STATUSES } from './run-status';
export type { RunTerminalStatus } from './run-status';
```

- [ ] **Step 6: Dedup the inline terminal check in `service.ts`**

In `src/modules/agent-delivery/service.ts`, add a new import alongside the other relative imports at the top of the file:
```ts
import { RUN_TERMINAL_STATUSES } from './run-status';
```
Then replace the check at line 200:
```ts
    if (run.status === 'completed' || run.status === 'failed' || run.status === 'halted') {
```
with:
```ts
    if ((RUN_TERMINAL_STATUSES as readonly string[]).includes(run.status)) {
```
Leave the `throw new InvalidStateError(...)` body and everything else unchanged. Behavior is identical — the terminal set is the same three statuses.

- [ ] **Step 7: Verify + commit**

```bash
npm run test -- src/modules/agent-delivery/run-status.test.ts
npm run typecheck
git add src/modules/agent-delivery/run-status.ts src/modules/agent-delivery/run-status.test.ts src/modules/agent-delivery/index.ts src/modules/agent-delivery/service.ts
git commit -m "feat(agent-delivery): isRunActive helper + dedup terminal-status check"
```
Expected: unit test PASS, typecheck clean. (The existing agent-delivery integration tests already cover the `service.ts` terminal branch; behavior is unchanged.)

---

### Task 2: `RunLivePoller` client component + wire into `AgentRunPanel`

**Files:**
- Create: `src/app/projects/[id]/RunLivePoller.tsx`
- Modify: `src/app/projects/[id]/AgentRunPanel.tsx`

**Interfaces:**
- Consumes: `isRunActive` from `@/modules/agent-delivery` (Task 1). `useRouter` from `next/navigation`.
- Produces: default-exported React component `RunLivePoller({ active }: { active: boolean })`.

- [ ] **Step 1: Create the poller component**

Create `src/app/projects/[id]/RunLivePoller.tsx`:
```tsx
'use client';

import { useEffect } from 'react';
import { useRouter } from 'next/navigation';

const POLL_INTERVAL_MS = 4000;

// US-11.9 — while an agent-delivery run is still progressing, refresh the
// server component on an interval so the run panel advances without a manual
// reload. router.refresh() re-runs the force-dynamic page (re-fetching
// getRunForProject) and reconciles in place. Ticks are skipped while the tab
// is hidden; polling stops entirely once the run is no longer active.
export default function RunLivePoller({ active }: { active: boolean }) {
  const router = useRouter();

  useEffect(() => {
    if (!active) return;
    const id = setInterval(() => {
      if (typeof document !== 'undefined' && document.hidden) return;
      router.refresh();
    }, POLL_INTERVAL_MS);
    return () => clearInterval(id);
  }, [active, router]);

  if (!active) return null;
  return (
    <span className="run-live" aria-live="polite">
      ● Live — updating automatically
    </span>
  );
}
```

- [ ] **Step 2: Wire it into `AgentRunPanel`**

In `src/app/projects/[id]/AgentRunPanel.tsx`:

Add the imports at the top (after the existing `MilestoneGateActions` import):
```tsx
import { isRunActive } from '@/modules/agent-delivery';
import RunLivePoller from './RunLivePoller';
```

In the `run-status` div, add the poller after the current-phase line. Replace:
```tsx
      <div className="run-status">
        <span className={`gift-chip gift-chip-run-${run.status}`}>
          {RUN_STATUS_LABEL[run.status] ?? run.status}
        </span>
        <span className="detail-line">
          Current phase: {PHASE_LABEL[run.currentPhase] ?? run.currentPhase}
        </span>
      </div>
```
with:
```tsx
      <div className="run-status">
        <span className={`gift-chip gift-chip-run-${run.status}`}>
          {RUN_STATUS_LABEL[run.status] ?? run.status}
        </span>
        <span className="detail-line">
          Current phase: {PHASE_LABEL[run.currentPhase] ?? run.currentPhase}
        </span>
        <RunLivePoller active={isRunActive(run.status)} />
      </div>
```

- [ ] **Step 3: Verify build-level correctness**

Run:
```bash
npm run typecheck && npm run lint
```
Expected: both clean. (`AgentRunPanel` is a server component; importing the pure `isRunActive` from the module is fine, and `RunLivePoller` is a `'use client'` child — the standard server-imports-client pattern already used on this page for `MilestoneGateActions`.)

- [ ] **Step 4: Commit**

```bash
git add src/app/projects/[id]/RunLivePoller.tsx src/app/projects/[id]/AgentRunPanel.tsx
git commit -m "feat(ui): live auto-refresh for the agent-delivery run panel"
```

---

### Task 3: Optional style + manual end-to-end verification

**Files:**
- Modify: `src/app/globals.css` (or the stylesheet defining `.run-status` / `.detail-line`) — add a subtle `.run-live` style.

**Interfaces:**
- Consumes: `RunLivePoller`'s `.run-live` span (Task 2).
- Produces: nothing consumed by later tasks.

- [ ] **Step 1: Locate the stylesheet that defines the run-panel classes**

Run: `grep -rn "\.run-status\|\.run-budget\|\.detail-line" src/app --include=*.css | head`
Use the file that defines `.run-status` (the run-panel styles). If those classes live in a global stylesheet, add there; match the existing muted/caption style used by `.detail-line`.

- [ ] **Step 2: Add a minimal, theme-consistent style**

Append near the other `.run-*` rules (adjust the property values to match the neighbouring muted-caption style already in the file — do not invent new design tokens):
```css
.run-live {
  margin-left: 8px;
  font-size: 0.8rem;
  color: #16a34a; /* green "live" dot+label; match any existing success/positive colour token if one exists */
}
```
If the file already defines a success/positive colour variable, use it instead of the literal.

- [ ] **Step 3: Commit the style**

```bash
git add src/app/**/*.css
git commit -m "style(ui): subtle live-indicator style for the run panel"
```

- [ ] **Step 4: Manual end-to-end verification in the running app**

Preconditions: Postgres up (`docker compose up -d db`), app DB migrated + seeded (`DATABASE_URL=postgres://hodorhub:hodorhub@localhost:5432/hodorhub npm run db:migrate && npm run db:seed`), dev server (`npm run dev`) and worker (`npx tsx --env-file=.env.local src/worker/index.ts`) both running.

Steps:
1. Sign in as `corp@hodorhub.test` (Password123!), open a published project owned by the charity you can accept as, and fund agent delivery via the form.
2. Sign in as `charity@hodorhub.test`, open the same project page — the **Agent delivery run** panel shows and displays `● Live — updating automatically` while the run is non-terminal.
3. Without touching reload, approve each milestone gate as it appears. Confirm the panel advances requirements → design → build → delivery → **Completed** on its own (within ~4s of each worker advance), the budget line updates, and the staging URL appears.
4. Confirm the `● Live` indicator disappears once the run reaches **Completed** (polling stopped).
5. Switch to another browser tab for ~15s, then return — confirm the page is not hammering refresh in the background (ticks skip while hidden) and resumes on return.

Expected: the panel is live end-to-end and stops polling at the terminal state. Record the outcome; if anything fails, treat as a normal debugging cycle (no plan change unless a design assumption was wrong).

---

## Self-Review notes

- **Spec coverage:** `isRunActive`/`RUN_TERMINAL_STATUSES` + unit tests (Task 1); `service.ts:200` dedup (Task 1, Step 6); `RunLivePoller` with 4s interval, skip-on-hidden, subtle indicator, and thin-shell convention (Task 2); wiring into `AgentRunPanel` on the `force-dynamic` read path (Task 2); manual running-app verification for the client component per the no-jsdom convention (Task 3). Non-goals (no API/worker/schema/endpoint changes, no new controls) are respected — only the two new files, the module barrel, the one-line `service.ts` dedup, `AgentRunPanel`, and an optional CSS rule are touched.
- **Placeholders:** none — all code is concrete. Task 3 Step 1/2 intentionally locates the stylesheet at execution time (the exact CSS file is discovered via grep) and gives the concrete rule to add; the only variability is matching an existing colour token, which is specified.
- **Type consistency:** `isRunActive(status: string): boolean` and `RUN_TERMINAL_STATUSES` are used identically in Task 1 (definition, `service.ts`) and Task 2 (`AgentRunPanel` prop `active={isRunActive(run.status)}`, poller prop `{ active: boolean }`). `RunLivePoller` default export imported as a default in Task 2.
