# Admin Run Controls & Kill Switch (US-11.5) — Design

**Date:** 2026-08-05
**Status:** Approved (brainstorming)
**Scope:** Backend + API only. Give a platform admin a working way to pause, resume, or halt an agent-delivery run, and a reversible platform-wide brake that stops every run at its next step boundary. No seam changes, no admin UI, no in-flight interruption.

## Problem

US-11.5 is the last unbuilt safety control of the five the backlog names as MVP-blocking for Epic 11 (budget ceiling US-11.4 ✅, merit-blind US-11.9 ✅, sandbox/deploy isolation US-11.6 ✅, human gates US-11.3 ✅, kill switch ⛔). Slice 3b wired a **real** Anthropic provider, so runs now spend real money: the per-run budget ceiling caps spend *within* a run, but no operator brake exists at all.

The domain layer is, however, already largely built — the gap is narrower than the backlog implies:

**Already done.** `setRunStatus` (`src/modules/agent-delivery/service.ts:191`) takes `'paused' | 'running' | 'halted'`, checks `isPlatformAdmin` against the **database**, refuses any run already in a terminal state, writes a `RunStatusChanged` outbox event, and emits `RunClosed` on halt. The engine honours the result via compare-and-set *before* every model call (`orchestrator.ts:91,242`, `delivery.ts:24`) — "kill switch wins" is already the documented CAS intent. `RunStatusChanged` is already in the relay's agent-delivery event list (`src/modules/notifications/relay.ts:16`), so a `paused → running` flip already re-enqueues that run's advance. All of it is integration-tested.

**Missing.**

1. **No HTTP route.** `setRunStatus` has **zero non-test callers** — an admin cannot invoke it. Compare `/api/admin/verifications/[id]/approve`, which exists; there is no `/api/admin/runs/…`.
2. **No platform-wide control.** Only per-run exists. This is the "intervene instantly" case that matters most now that spend is real.
3. **No audit-log entry** for either admin action. US-11.10 requires every human decision to be traceable; `setRunStatus` writes only the outbox event, while `src/modules/moderation/service.ts:79,99` already establishes the `audit_log` precedent for admin actions.

## Resolved product ambiguities

**"The sandbox is torn down" is already structurally satisfied.** `E2bSandboxRunner.runBuild()` creates the sandbox at the top and calls `sbx.kill()` in a `finally` (`src/lib/e2b-sandbox-runner.ts:63-79`). No sandbox handle or id is persisted anywhere and none outlives a single call, so there is no orphan sandbox for an admin to tear down. This AC needs a **regression test asserting the property**, not new teardown machinery.

**"Intervene instantly" vs "halt between steps."** The story title promises the former, its acceptance criterion says the latter. Decision: **between steps**, matching the AC. An in-flight model call or `npm ci && npm test` runs to completion — up to several minutes, still spending — before the CAS check catches it at the next boundary. Interrupting in-flight work would require threading cancellation through the frozen `ModelProvider` and `SandboxRunner` seams plus persisting sandbox ids, and the E2B kill path could not be verified without Plan B2 credentials. Not worth it for the stated AC.

**"Per workspace" does not apply to this path.** US-11.2 is explicit that an agent-delivery run creates *no* delivery workspace — that belongs to the human donated-time path (US-5.3, US-6.x). The phrase is inherited wording. Decision: build **per-run + platform-wide only**, and correct US-11.5's text in `PRODUCT_BACKLOG.md` rather than silently ignoring a stated AC.

**API-only.** No admin UI exists anywhere in the app; all seven existing admin controls are API-driven. The first admin console should cover all eight controls as its own slice, not get bolted onto this one.

## Approach (chosen: A — singleton `platform_controls` table)

No settings or feature-flag table exists today; `plans`/`subscriptions`/`entitlements` are the per-org billing seam and are the wrong shape. The platform brake gets a **singleton table with a typed boolean column**, `agent_delivery_paused`, plus `updated_by` and `updated_at`. Singleton-ness is enforced in the schema by a `CHECK` on a fixed id — the same instinct as migration 0006's partial unique index, which puts an invariant in the database rather than in code.

Alternatives considered and rejected:

- **B — generic `platform_flags(key, value)` KV.** More general, but every consumer then hand-rolls parsing and default-guessing, and there is no second flag to justify the abstraction. YAGNI.
- **C — environment variable.** Rejected outright: flipping it requires a redeploy, which is useless during the incident the switch exists for.

A gives the dispatcher a boolean with no parsing and no ambiguous default, and keeps the invariant where it cannot drift.

## Components

### 1. Schema — `platform_controls` (new, + migration)

```ts
/** The one and only platform_controls row. */
export const PLATFORM_CONTROLS_ID = '00000000-0000-0000-0000-000000000001';

export const platformControls = pgTable(
  'platform_controls',
  {
    id: uuid('id').primaryKey(),
    agentDeliveryPaused: boolean('agent_delivery_paused').notNull().default(false),
    updatedBy: uuid('updated_by').references(() => users.id),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => ({
    singleton: check('platform_controls_singleton', sql`${t.id} = ${PLATFORM_CONTROLS_ID}`),
  }),
);
```

Matches the house table-extras style — the `(t) => ({ … })` object form and `check(...)` used by `compute_pledges` (`src/db/schema.ts:411-416`); `check` and `boolean` are already imported in the schema. `PLATFORM_CONTROLS_ID` is a named constant rather than a magic literal at each call site.

**The migration seeds no row, by design.** `resetDb()` truncates every public table not matching `drizzle%`/`pgboss%` before every integration test (`src/test/db.ts:23-31`), so a seeded singleton row would be wiped and every brake read would hit a missing row. Instead: the reader treats **no row as not paused** — which is precisely what the column default means, i.e. the brake has never been pulled — and the writer **upserts**. This removes the bootstrap problem, leaves the shared test harness untouched, and the `CHECK` still guarantees at most one row. It does not weaken the fail-safe rule below: a missing row is a known state with a defined meaning, whereas a *thrown* read error still propagates.

### 2. Domain — `src/modules/agent-delivery/platform-controls.ts` (new)

Its own small file, following the module's existing one-concern-per-file convention (`budget.ts`, `reads.ts`, `run-status.ts`):

- `isAgentDeliveryPaused(db): Promise<boolean>` — reads the singleton row; **no row means not paused**.
- `setAgentDeliveryPaused(actingUserId, paused, db): Promise<void>` — in one transaction: `isPlatformAdmin` **database** check → **upsert** the row (`agentDeliveryPaused`, `updatedBy`, `updatedAt`) → `audit_log` entry → `PlatformBrakeChanged` outbox event.

The domain-layer DB admin check is what actually protects the switch. `requirePlatformAdmin()` (`src/lib/auth.ts:17-21`) only trusts the cookie's `isPlatformAdmin` claim, which is tech-debt **M4** — baked into a 7-day cookie with no revocation. The route gate is an edge filter; the authoritative check must stay in the domain, exactly as `setRunStatus` already does it.

Both functions are exported from `src/modules/agent-delivery/index.ts`.

### 3. Dispatcher — brake check in `advanceRun`

`advanceRun` (`src/modules/agent-delivery/dispatcher.ts`) is the **single choke point**: one production caller (`src/worker/index.ts:106`), fed by both the event-driven enqueue and the reconciliation sweep. The brake is checked there, before the runnable-status check, and returns the existing non-runnable shape:

```ts
if (await isAgentDeliveryPaused(db)) {
  return { ran: false, status: run.status, phase: run.currentPhase };
}
```

Enforcing it in the domain rather than in the worker keeps it integration-testable without pg-boss and covers any future caller by construction.

### 4. Audit-log entries for both admin actions

Add an `audit_log` insert to `setRunStatus` (`entity: 'agent_delivery_run'`, `entityId: runId`, metadata carrying the new status) and to `setAgentDeliveryPaused` (`entity: 'platform_controls'`, `entityId: null`, metadata carrying the new value). Both inside the existing transaction, matching `moderation/service.ts`. This closes the US-11.10 traceability gap for admin decisions — a targeted improvement to the code being touched, not scope creep.

### 5. HTTP routes (new)

Both follow `src/app/api/admin/verifications/[id]/approve/route.ts` exactly — `requirePlatformAdmin()`, then the domain call, then `errorResponse(e)`:

- `POST /api/admin/runs/[id]/status` — zod body `{ status: 'paused' | 'running' | 'halted' }` → `setRunStatus`.
- `POST /api/admin/agent-delivery/brake` — zod body `{ paused: boolean }` → `setAgentDeliveryPaused`.

### 6. Docs

- `PRODUCT_BACKLOG.md` — correct US-11.5's "per workspace" wording and note the resolution.
- `ARCHITECTURE.md` — one line on the platform brake and where it is enforced.

## Data flow

**Per-run.** Admin POST → `setRunStatus` in one transaction (admin DB check → terminal guard → status write → `audit_log` → `RunStatusChanged` outbox → `RunClosed` if halted) → relay → `agent.advance` → dispatcher sees `paused` → no-op. Resume emits `RunStatusChanged` again, which re-enqueues the advance. Already wired end to end.

Note the asymmetry, which is correct per the story: `paused` is **not** in `RUN_TERMINAL_STATUSES` (`['completed','failed','halted']`), so a paused run can be resumed; `halted` **is** terminal, so stopping a run is deliberately irreversible. A paused run also still reads as active to `isRunActive`, so the live-refresh poller keeps polling and will show the resumption — desirable.

**Platform-wide.** Admin POST → flag row + audit entry. No per-run events fire, so live runs simply stop at their next step boundary with their statuses untouched — nothing is lost, and the brake is reversible. On release, runs resume via the **5-minute reconciliation sweep** (`RECONCILE_SWEEP_CRON`), which exists precisely to catch "runnable run whose enqueue was lost". Resume therefore needs no new machinery, at the cost of **up to 5 minutes of resume latency** — accepted for an incident-recovery path. The alternative, teaching the relay a second run-less event shape, buys little.

## Error handling

Existing mappings in `src/lib/http.ts` cover every case with no new codes: non-admin → 403 `forbidden`, unknown run → 404 `not_found`, already-terminal run → 409 `invalid_state`, malformed body → 400 via `ZodError`.

**The brake must not fail open.** If reading `platform_controls` throws, `advanceRun` propagates the error so the pg-boss job retries. It must never fall back to "assume not paused" — that would silently defeat the switch during exactly the database trouble that might have prompted an operator to pull it.

## Testing

Integration tests against real Postgres (`src/modules/agent-delivery/`), matching the module's existing style:

- Admin pauses a run; a paused run does not advance; resuming it does advance.
- Admin halts a run; the run is terminal; `setRunStatus` then refuses further changes (409).
- Non-admin is refused (403) for both the per-run and platform-brake paths.
- Brake on → **every** active run no-ops, statuses untouched; brake off → runs advance again.
- Brake read failure propagates rather than advancing (fail-safe, not fail-open).
- With no `platform_controls` row at all, `isAgentDeliveryPaused` returns `false` and runs advance normally (the post-truncation default state).
- Pulling the brake twice in a row upserts rather than erroring, and the `CHECK` still permits only one row.
- `audit_log` rows are written for both admin actions.

Unit test: `E2bSandboxRunner` calls `kill()` even when the build command throws — locks the already-satisfied teardown AC so the `finally` cannot regress.

Route-level authz and status codes go in the existing contract-test style (`src/app/api/agent-delivery.contract.integration.test.ts`).

The full gate before commit: `typecheck`, `format:check`, `lint`, `test:coverage`, `test:integration` (both `TEST_DATABASE_URL` and `DATABASE_URL` set to `hodorhub_test`), `build:workers`, `build`.

## Out of scope

No changes to the `ModelProvider` or `SandboxRunner` seams. No in-flight interruption. No admin UI. No per-workspace or per-org scope. Tech-debt **H2** (coverage gate over `src/modules/**`) stays a separate follow-up rather than riding along on this slice.
