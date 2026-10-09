# Production Promotion Gate (US-11.8) — Design

**Story.** *As a Charity Owner, I want promoting the app from staging to production to be a separate, explicit approval so that going live is a deliberate decision, not an automatic one.*

**AC.** *Given an approved app on staging, when I approve promotion, then a privileged deployer promotes it to production; the agents never promote to production themselves.*

## The shape: request, then a privileged deployer acts

Promotion is **two steps in two processes**, mirroring how the staging deploy already works:

1. The charity owner POSTs an explicit promotion request. The web tier records **intent only** — it never deploys.
2. The pg-boss worker, holding the privileged deployer identity, performs the production deploy and records the result.

The alternative — deploying synchronously inside the route — was rejected on two grounds. A real Cloud Run deploy takes minutes, which does not belong under an HTTP request; and it would put deploy credentials in the Next server, where nothing else needs them. Keeping the deployer in the worker is what makes "a privileged deployer promotes it" literally true: a separate identity in a separate process, reached only through an event.

This also gives the story its teeth for free. The agents' path (`advanceRun` → `runDeliveryPhase`) has no route to the promotion code at all; it is not a flag the orchestrator could set wrongly.

## State lives in `deployed_environments`

No new table. `deployed_environments` already carries `environment: 'staging' | 'production'` and `status: 'deploying' | 'live' | 'failed' | 'torn_down'`, and is already the one place that answers "what is deployed where". A promotion is a `production` row moving `deploying → live` (or `failed`).

The one gap is attribution (US-11.10): the table records no actor. Add a nullable `promoted_by` referencing `users.id` — set on production rows, left null for staging rows, which nobody approves.

## Domain — `src/modules/agent-delivery/promotion.ts`

**`requestProductionPromotion(actingUserId, runId, db?) → { promotionId }`**

Charity-owner-only, re-checked against the database. A caller outside the run's charity org gets `NotFoundError`, not `ForbiddenError` — no existence leak to another tenant, matching `loadMilestoneAsCharityOwner`.

Preconditions, each an `InvalidStateError` (→ 409):
- the `delivery` milestone is `approved` — this is what "an approved app on staging" means;
- a `live` staging deployment exists — you cannot promote what is not running;
- no `production` row is already `deploying` or `live` — one promotion at a time, and no silent re-promote.

Writes the `production` row (`deploying`, `promotedBy`), an `agent_delivery.promotion.requested` audit entry, and a `ProductionPromotionRequested` outbox event carrying both org ids.

**`runProductionPromotion(promotionId, deployer, db?) → { status: 'live' | 'skipped' }`**

Runs in the worker. Returns `skipped` unless the row is still `deploying`, so a pg-boss retry after a partial success cannot deploy twice. Reads `artifactRef` from the `build` milestone — the same artifact the charity approved on staging, never a fresh build.

On success: `live` + url/revisionRef/deployedAt, an `agent_delivery.promotion.deployed` audit entry, and a `ProductionPromoted` event. On failure: mark the row `failed`, then **rethrow**. A `failed` row does not block a new request, so recovery is another deliberate human approval rather than an automatic retry — which is the point of the story. Marking `failed` and rethrowing means pg-boss records the failure while the next attempt is a no-op `skipped`, not a double deploy.

## Wiring

- **Relay.** `relayOutbox` gains a second optional hook, `onPromotionRequested(promotionId)`, alongside the existing `onAgentDeliveryEvent(runId)`. Additive and default-no-op, exactly like the first.
- **Worker.** A new `agent.promote` queue, `singletonKey: promotionId`, running `runProductionPromotion` with the env-selected deployer (`AGENT_DELIVERY_DEPLOYER`, default `fake`).
- **Notifications.** `ProductionPromoted` → `agent_run.promoted` for the charity owner and the CSR manager, following the US-11.5 pattern (org ids ride on the payload).
- **Route.** `POST /api/runs/[id]/promote`, no body, returning `{ ok: true, promotionId, status: 'deploying' }`.
- **Reads.** `getRunForProject` currently returns a single `deployedEnvironment` chosen by `findFirst` over any `live` row — ambiguous the moment a production row goes live. It returns `staging` and `production` separately instead.
- **UI.** The run panel shows the production URL when live, a "Promote to production" control for the charity owner once eligible, and a "Promoting…" state while `deploying`. Without it the story's actor cannot perform the approval.

## The guard

A test drives a full run through every phase with a recording `FakeDeployer` and asserts every `deploy` call used `environment: 'staging'` — the agents never promote. This is the US-11.8 counterpart to the `merit-integrity` guards.

## Out of scope

Real production infrastructure (Plan B2 — `cloudrun` still throws); custom domains; rollback and tear-down of a live production service; promotion of anything but the approved build artifact; any admin-initiated promotion (the story gives this to the charity, and only the charity).

---

## Live-verification outcome (2026-09-01)

Driven against the real stack (docker compose db + mailhog, migrate, seed, dev on :3000, worker on :8080) with the seeded accounts and the fake deployer.

**Run 1** (`d1eac591-...`, "Promotion gate verification"): funded by Globex at `budgetMinor: 50000`, template `static-site`, then all four gates approved by the charity through the API while the worker advanced each phase.

At `completed`, `deployed_environments` held exactly one row — `staging | live` — and **no production row**. The agents ran the whole delivery and never promoted, which is the AC's negative half observed rather than asserted.

The gate itself:

| Caller | Result |
|---|---|
| Funding corporation | **404** — the run is not theirs to promote |
| Platform admin | **404** — the story gives this to the charity alone |
| Anonymous | **401** |
| Charity owner | **200** `{"ok":true,"promotionId":"b51718dc-…","status":"deploying"}` |
| Charity owner, immediately again | **409** |

The worker picked the request up within ~3 s (`[worker] agent.promote b51718dc-… live`) and the production row went `live`. `promoted_by` is set on the production row and null on staging. Both parties were notified, and both audit rows are attributed to the charity owner rather than to the worker that carried the deploy out:

```
agent_run.promoted              | charity@hodorhub.test
agent_run.promoted              | corp@hodorhub.test
agent_delivery.promotion.requested | charity@hodorhub.test
agent_delivery.promotion.deployed  | charity@hodorhub.test
```

The project page (200) showed both "Deployed to staging" and "Live in production", and no longer offered the promote control once production was live.

**Run 2** (`182cf6ef-...`) was driven to the same approved-on-staging state and stopped there, to check the affordance rather than its absence: the charity owner's page offers "Promote to production" exactly once, and the funding corporation's page does not offer it at all.

**Gate at verification time:** typecheck, lint and `format:check` clean; **119 unit tests / 25 files**, coverage **96.25 stmts / 92.91 branch**; **189 integration tests / 33 files**; `build:workers` (`grep -c argon2 dist/worker.cjs` = 1, the documented deliberate state) and `build` clean, with `/api/runs/[id]/promote` in the route manifest.

**Note on the test environment:** two earlier integration runs failed with 30 s *hook* timeouts (`resetDb`'s TRUNCATE blocking) while a dev server, worker, or `npm run build` was running against the same Postgres container. Both failures were environmental, not logic: the suite is green when run alone, and the affected tests pass in isolation. Do not run the integration suite alongside the app.

**Known cosmetic limitation:** `FakeDeployer` derives its URL from the run id alone, so staging and production report the *same* URL under the fake. Harmless for the fake — the tests assert on `environment`, not the URL — but a real deployer must return distinct URLs, and the fake could be made to reflect that.

No defects found. US-11.8 verified end to end.
