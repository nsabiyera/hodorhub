# HodorHub — Tech-Debt Register

Findings from the engineering review of the stack & architecture (after the Identity, Projects, and Commitments slices). Decision: **capture and keep building**; address at a hardening milestone **before launch** (the architectural-risk items should be closed before many more slices pile on assumptions that aren't yet true). Nothing here is an architectural dead-end.

Recurring theme: several controls are **documented as built but not implemented** (CSRF, rate limiting, email verification, observability, KMS). The gap between designed and built posture is the thing to watch.

## Architectural-risk — close before further async-dependent slices

| ID | Item | Why it matters | Recommendation |
|----|------|----------------|----------------|
| ~~A1~~ | ✅ **RESOLVED.** Outbox relay built (`src/modules/notifications/relay.ts`, `FOR UPDATE SKIP LOCKED`, runs in the worker every 3s); Notifications consumer (`service.ts`) is the single source of in-app notifications; all inline `notifications` writes removed from Identity/Commitments/Delivery. | — | Done. Email dispatch is a future consumer add-on. |
| A2 | ~~`pg.Pool` connection budget~~ | 🟡 **Partly done.** App pool bounded via `DB_POOL_MAX` (default 5); ADR 0002 documents the `max_connections`/pooler sizing. Remaining: actual Cloud SQL sizing + pooler at deploy. |
| A3 | ~~pg-boss "CPU always allocated"~~ | ✅ **Documented (ADR 0002 deploy-time settings).** Apply the setting at deploy. |

## High

| ID | Item | Recommendation |
|----|------|----------------|
| H1 | 🟡 **Partly done.** In-process fixed-window limiter (`src/lib/ratelimit.ts`) applied to login (10/min/IP), registration (5/min/IP), and support (30/min/IP). Remaining: Redis-backed limiter for multi-instance (per-instance only today). |
| H2 | **Coverage gate excludes `src/modules/**`** — the authz checks and state machines (highest-risk code) aren't gated. | Add `src/modules/**` to `vitest.config.ts` coverage `include`. |
| H3 | **`SECURITY.md` claims CSRF tokens that don't exist** (SameSite+JSON actually protects us). | Correct the doc; add an `Origin`/`Sec-Fetch-Site` check on mutating handlers as defense-in-depth. |

## Medium

| ID | Item | Recommendation |
|----|------|----------------|
| M1 | **`beginDelivery` is public + privileged + un-authorized** (relies on caller having authorized). | Mark `@internal`/narrow the export or pass an authorized-actor capability; fine while one caller. |
| M2 | ✅ **RESOLVED.** Partial unique index `pledges_one_accepted_per_project` (migration 0006) enforces ≤1 accepted pledge per project even after reopen; acceptPledge maps the SQLSTATE 23505 to a clean InvalidStateError. Regression-tested. |
| M3 | ✅ **Mostly resolved.** Email verification built (token + verify sets `users.emailVerifiedAt`; sent at registration). Remaining: make it a **hard gate** on sensitive actions (currently mechanism-only). | Add the enforcement point. |
| M4 | **Stateless session has no revocation**; `isPlatformAdmin` baked into a 7-day cookie. | Shorten TTL; look up admin flag per request rather than embedding it; revocation list at scale. |
| M5 | **Caret ranges on 0.x drizzle** (`drizzle-orm ^0.45`, `drizzle-kit ^0.31`) and fast-moving Next/React/vitest. | Pin drizzle exactly and bump orm+kit together; rely on the committed lockfile + `npm ci` in CI. |
| M6 | **Login timing mitigation ineffective** — the dummy argon2 string fails at parse, not KDF, so it doesn't equalise timing. | Verify against a real precomputed argon2id hash generated at boot with the same options. |
| M7 | **The mailer is a no-op in production** (`src/lib/mailer.ts` logs in dev, does nothing under `isProd` — no SMTP wired). US-8.2 now offers users an *email* notification channel and US-8.1 verification/reset links already depend on it, so a real user-facing promise silently delivers nothing in prod. | Implement the `Mailer` interface against SMTP/a provider using the `SMTP_*` env; no caller changes needed. Until then, treat email-channel preferences as configured-but-undelivered. **Before wiring it:** the outbox relay now flushes queued emails sequentially after each tick (`notifications/relay.ts`) and the worker's `setInterval` has no in-flight guard, so 100 events x a 200ms SMTP round trip makes a tick outlast its own 3s interval and ticks overlap, each holding a pool connection. Add an in-flight guard (or move sending to its own queue) as part of the same change. |

## Low

- **`resetDb()` will truncate the dev database if `TEST_DATABASE_URL` is unset.** `src/test/db.ts` falls back to `DATABASE_URL`, which `.env.local` points at the *dev* database — so any ad-hoc script that imports the test helpers and calls `resetDb()` silently wipes local dev data (this happened on 2026-09-04 and cost a re-seed). Fix: make the fallback fail loudly instead, or refuse to truncate a database whose name lacks a `_test` suffix.

- No route-handler / e2e tests (`requireUser`, cookie issuance, `errorResponse` mapping untested).
- Observability is `console.warn/error`; ADR 0002 promises pino→Cloud Logging + SLO alerts — unwired.
- `interests` has no `(project_id, corporation_org_id)` dedup → interest/notification spam.
- `env.ts` uses `schema.partial()` under test/build; missing-var bugs surface only at prod boot.

## Overall verdict (for the record)
Sound foundation, no dead-ends; every issue is additive to fix. Priority order to close: **A1, A2, H1, H2, M2** — plus the honesty fixes to `SECURITY.md` and ADR 0002.
