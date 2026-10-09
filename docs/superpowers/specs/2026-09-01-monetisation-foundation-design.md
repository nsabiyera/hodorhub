# Monetisation Foundation & Feature Gating (US-10.1/10.2/10.3/10.5) — Design

## What was actually there

`plans`, `subscriptions` and `entitlements` were created in **migration 0000** and never touched again: no seed, no reads, no tests, and no `hasEntitlement` — the function US-10.1's acceptance criterion names literally. Release 1 shipped the *schema* of the monetisation foundation and none of its behaviour, while US-10.1 and US-10.2 were marked **Must**.

US-10.4 had a related gap: `scoring-boundary.test.ts` asserted scoring was blind to resource gifts and to agent-delivery tables, but nothing asserted it was blind to **plan tier** — the one thing that story is about.

## The catalogue is code

`plans.ts` declares `starter` / `team` / `enterprise` with their features and seat limits, the same reasoning as the agent-delivery template allow-list: what a plan includes is a reviewed decision, not a runtime toggle. Admin-managed pricing and comps are US-10.8 (a *Could*), and the per-organisation `entitlements` table is already the right seam for them — a row there grants a feature the plan does not, which is exactly how a grant-funded or complimentary account should work without editing the catalogue.

## Absent means Starter

`getPlanForOrg` returns Starter when there is no active subscription. That choice does three things at once: no corporation can reach a "no plan" state, no backfill was needed for organisations created before any of this existed, and a cancelled subscription degrades to free rather than to broken. A subscription pointing at a plan code the catalogue no longer knows also falls back to Starter — losing a feature is recoverable, a 500 on every gated request is not.

It is the same pattern as `platform_controls` in US-11.5: the absent row is a meaningful default, not a missing record.

## US-10.3 lives at the root of the gate

A non-corporation organisation returns `true` for every feature *before* any plan is consulted. Put anywhere else — a check at each call site, a Starter plan that happens to include everything — the rule would eventually be forgotten in one place, and that one place would be a charity hitting a paywall. At the root of `hasEntitlement` there is no code path that can refuse a charity for lack of a plan.

## 402, not 403

`PlanUpgradeRequiredError` maps to **402 Payment Required**. A gated feature is not a permission failure: the CSR manager is allowed to use it, their plan does not include it, and answering "forbidden" is both wrong and useless. The error carries the lowest plan that includes the feature so a prompt can name it.

The gate sits in the **domain** (`getCorporateImpact`), not only the page, so no other caller reaches the data without it. `/dashboard` catches the state and renders an upgrade prompt rather than disappearing or 404ing, which is what US-10.5 actually asks for.

## Scope held deliberately

- **The "1 active commitment" Starter limit is not enforced.** US-10.2 names it as an example, but capping concurrent commitments changes a shipped flow and would put existing corporations in breach. That is a product decision, raised in the backlog for sign-off, not something to slip in behind a foundation slice.
- **US-10.6 (subscribe & billing) is not built.** It needs a payment provider and real keys. `/billing` lists the plans and says plainly that self-serve subscription is not available yet rather than offering a button that cannot work.
- **US-10.7 (seats)** — `seatLimit` is in the catalogue and resolved by `getEntitlementSummary`, but nothing enforces it yet.

---

## Live-verification outcome (2026-09-01)

Driven against the real stack. The seeded Globex corporation has no subscription row, so it is on Starter.

```
GET /api/organisations/<globex>/impact   -> 402
{"error":"upgrade_required","message":"This feature is available on the Team plan."}
```

`/dashboard` returns **200** and renders the prompt rather than disappearing: *"Available on Team … You are on **Starter**. Everything in the core loop stays free — finding projects, pledging, and delivering are never gated."* with a link to `/billing`, which lists Starter, Team and Enterprise and states plainly that self-serve subscription is not available yet.

The gate flips both ways on the comp seam alone — no subscription needed:

| Step | Result |
|---|---|
| Starter, no grant | **402** |
| `insert into entitlements (organisation_id, feature) values (globex,'csr_dashboard')` | **200**, dashboard renders Donated time / Agent-delivered projects / approved hours |
| `delete from entitlements …` | **402** again |

US-10.3 holds live: the charity's project impact summary still returns **200**, and `/api/discover` is **200** for charity and corporation alike — nothing in the core loop was gated for anyone.

**Gate:** typecheck, lint, `format:check` clean; **131 unit / 27 files** (cov 96.25/92.91); **245 integration / 38 files**; `build` clean with `/billing` in the route manifest.

No defects found. US-10.1, US-10.2, US-10.3 and US-10.5 verified end to end; the US-10.4 payment-blind guard now exists.

---

# Seat Management (US-10.7) — addendum

The story had no acceptance criteria; they are drafted in the backlog alongside the resolution.

**A seat is a membership.** An invited colleague who has never signed in still holds one, because the seat is the *access*, not the activity — otherwise an organisation could invite unlimited people and only pay once they logged in.

**Re-inviting an existing member consumes no seat**, so it stays allowed at the limit. `inviteMember` is already idempotent; making a no-op invitation fail with "out of seats" would be a lie.

**Ownership split.** Identity owns memberships, so `countMembers`, `listMembers` and `removeMember` live there. Monetisation owns the limit, so `getSeatUsage` and `assertSeatAvailable` live there and call Identity's public reads. Monetisation already imports Identity; enforcing inside `inviteMember` would have made Identity import Monetisation and created a module cycle, so the gate runs in the **route**, before the invite. `inviteMember` stays the unguarded primitive — the same split as `Projects.beginDelivery` (tech-debt M1) — which also keeps seeds and test fixtures free to build state without tripping a plan limit.

**`null` means unlimited**, not a large number. A sentinel like `Infinity` or `9999` invites an accidental comparison that silently caps Enterprise.

**Removing the last administrator is refused.** An organisation with no `csr_manager` or `charity_owner` can never invite anyone again — an unreachable-by-design state, so the domain refuses to create it.

## A guard that was passing for the wrong reason

While adding the seat work, lint flagged `no-control-regex` in the payment-blind guard added earlier in this session: the `\b` word boundaries had been written as literal backspace characters (`\x08`), so the regex matched nothing and the test passed vacuously. It was rebuilt with `new RegExp([...].join('|'))` and then **proved** by temporarily adding `hasEntitlement` to `scoring/service.ts` and confirming the guard failed, before restoring the file from git. A guard test that has never been seen to fail is not yet evidence of anything.

## Seat management — live verification (2026-09-01)

Driven against the real stack as the seeded Globex CSR manager (Starter, 5 seats, 2 in use).

| Step | Result |
|---|---|
| Invite 3 more, filling the plan | **201** ×3 |
| Invite a 6th | **402** — *"All 5 seats on your plan are in use. The Team plan has more."* |
| Re-invite an **existing** member at the limit | **201**, `membershipCreated: false` — no seat consumed |
| Remove the last administrator | **409** — *"An organisation must keep at least one administrator."* |
| Remove a volunteer | **200** |
| Invite again after freeing the seat | **201** |

Usage reads back as `{used: 5, seatLimit: 5, remaining: 0, planName: 'Starter'}`, and the charity as `{used: 1, seatLimit: null, remaining: null}` — no limit, confirming US-10.3 holds for seats as well as features.

**Gate:** typecheck, lint, `format:check` clean; **131 unit / 27 files** (cov 96.25/92.91); **257 integration / 39 files**; `build` clean with both member routes in the manifest.

No defects found. US-10.7 verified end to end.

---

# Subscribe & Manage Billing (US-10.6) — addendum

## Built behind a seam, like every other external dependency

`PaymentProviderClient` is the contract; `FakePaymentProvider` is deterministic and offline; `getPaymentProvider` selects on `PAYMENT_PROVIDER` (default `fake`) and **throws** for `'stripe'` until keys and the SDK exist. The rule is the one `getModelProvider` already follows: never silently fall back to a fake, because a workspace upgraded "for free" while an operator believes it was paid for is worse than an error.

Going live is then a contained job: implement `StripePaymentProvider` against the same four methods, set `PAYMENT_PROVIDER=stripe`, supply `STRIPE_SECRET_KEY`. No domain code changes.

## Nothing moves until money does

`startSubscription` returns a checkout URL and **writes nothing at all**. An abandoned checkout therefore cannot leave a half-upgraded organisation behind, and there is no "pending" state to reconcile. Entitlements change only in `activateSubscription`, reached only from a verified callback.

## The signature is the authority

`POST /api/billing/callback` is deliberately unauthenticated by session — the caller is the provider, not a user. Its authority is the signature, and verification lives **inside the provider adapter** so no route can accidentally trust an unsigned body. The route reads `req.text()` rather than `req.json()` because verification must see exactly the bytes that were signed. An unsigned, forged, or unknown-checkout payload cannot produce a `ConfirmedCheckout`, so it can never activate a plan — asserted directly in the tests.

## Idempotent by construction

Providers retry callbacks. Activation keys on `subscriptionRef`: a replay updates the same row, and a genuine upgrade supersedes the previous active subscription rather than stacking a second one. "At most one active subscription per organisation" is enforced on every activation, not assumed.

## Invoices are not mirrored

The provider is their system of record. A local copy would drift the moment a refund or adjustment happened there, and the drift would be invisible. An organisation that has never paid has no customer at the provider, so the honest answer is an empty list rather than an error.

## Subscribe & billing — live verification (2026-09-01)

Driven against the real stack as the seeded Globex CSR manager, on `PAYMENT_PROVIDER=fake`.

| Step | Result |
|---|---|
| Dashboard before subscribing | **402** |
| `POST …/subscription {"planCode":"team"}` | **200** with a checkout URL |
| Dashboard immediately after | **402** — starting a checkout changes nothing |
| Callback with **no** signature | **400** `invalid_signature` |
| Callback with a **wrong** signature | **400** `invalid_signature` |
| Callback correctly signed | **200** `{"planCode":"team"}` |
| Dashboard now | **200** — entitlements updated |
| Seats | `{used: 5, seatLimit: 50, planName: 'Team'}` — limit raised by the same upgrade |
| `GET …/invoices` | one paid £99.00 GBP invoice |
| `/billing` | shows Team as *Current plan*, the invoice, and *Cancel subscription* |
| `DELETE …/subscription` | **200** `{"planCode":"starter"}` |
| Dashboard after cancelling | **402**; seats back to `{seatLimit: 5}` |
| Cancelling again | **409** |
| Charity subscribing on the corporation's behalf | **404** |

### A defect found by driving it

The first live attempt failed on a **correctly signed** callback. The fake held its checkouts in a module-level `Map`, and Next compiles each route into its own module graph in dev — so the instance that created the checkout was not the one the callback route read, and a valid confirmation looked like an unknown checkout.

Every integration test passed regardless, because in-process they share one instance. Only driving it through two real HTTP routes exposed it.

The fake is now **stateless**: the checkout id encodes the organisation and plan (`fake_cs_<base64url(orgId:planCode)>`), so verification works across module instances, restarts and processes — which is also closer to how a real provider behaves from our side, since it looks the session up in its own store rather than ours. A unit test now asserts a *different instance* can confirm a checkout.

**Gate:** typecheck, lint, `format:check` clean; **138 unit / 28 files** (cov 96.66/93.61 — the seam needed its own unit tests to hold the 90/85 gate); **271 integration / 40 files**; `build` clean with all four billing routes in the manifest.

US-10.6 verified end to end, on the fake provider.
