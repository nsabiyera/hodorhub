# HodorHub — Monetisation Model (draft v0.1)

> Resolves the last MVP-blocking open question from [`PRODUCT_BACKLOG.md`](./PRODUCT_BACKLOG.md). Generates **Epic 10 — Monetisation & Billing**. Has architectural consequences (a Billing & Entitlements module in [`ARCHITECTURE.md`](./ARCHITECTURE.md)).

## 1. Guiding principles (these constrain every option below)

1. **Charities and supporters never pay.** They are the beneficiaries and the demand signal; charging them contradicts the mission and the audience that can least afford it.
2. **Corporations fund the platform.** They hold CSR budgets and receive the measurable, reportable value (impact, employee engagement, recognition). Willingness-to-pay lives here.
3. **Merit is never for sale.** The support score (US-3.5) and discovery ranking (US-4.2) must be *completely* insulated from payment. No paid tier buys a higher rank or preferential access to a charity — a charity's freedom to accept/decline any pledge (US-5.3) is absolute regardless of the corporation's plan. This protects the integrity the whole matching loop depends on (US-9.3).
4. **The free tier must complete the core loop.** A corporation must be able to discover → express interest → deliver → log approved hours for *free*, so it experiences real value before it's ever asked to pay.

## 2. Chosen model: corporate freemium SaaS subscription

Free for charities and supporters; corporations subscribe. Paid value is the **reporting, recognition, scale, and integration** features — never access to the core loop or to ranking.

| Tier | Audience | Included | Price basis |
|------|----------|----------|-------------|
| **Charity / Supporter** | All charities & public | Everything they do — posting, promoting, accepting pledges, receiving delivery. **Always free, forever.** | £0 |
| **Corporate — Starter** | Corporations trialling | Discover/browse/filter, express interest, **1 active delivery commitment**, basic hour logging + approval, 1 admin + up to N volunteer seats. | £0 |
| **Corporate — Team** | Corporations running CSR programmes | Everything in Starter + **multiple concurrent commitments**, full CSR dashboard & impact reporting (US-7.1), watchlists/alerts (US-4.4), recognition badges (US-7.5), unlimited volunteer seats. | Annual subscription (value-based; range TBD) |
| **Corporate — Enterprise** | Large corporates | Everything in Team + skill-based recommendations (US-4.3), HR/CSR-system integration (Benevity-style sync), SSO, white-label branding, audit exports (US-9.4), dedicated support. | Custom annual contract |

The paid features map deliberately onto **Release 2 and Release 3** stories — so nothing needs to be built *only* to have something to charge for; monetised value is the natural upsell of the reporting/scale roadmap.

## 3. Why this over the alternatives

| Alternative | Verdict |
|-------------|---------|
| **Charge charities** | Rejected — violates Principle 1. |
| **Transaction / cut of donated value** | Rejected — hours aren't cash; taking a "cut" of charitable delivery is reputationally toxic and hard to value. |
| **Pay-to-rank / featured placement affecting discovery** | Rejected — violates Principle 3; corrupts the core signal. |
| **Grant / foundation funding** | Adopted as a *complement*, not the core — subsidises early operations and keeps the charity side free while corporate revenue ramps. Not a scalable standalone. |
| **Clearly-labelled sponsored slots (not affecting score)** | Deferred/optional (US-10.8) — only if it can be visually and algorithmically separate from merit ranking. |
| **Optional supporter cash donations to projects** | Deferred (US-10.9) — a distinct fundraising direction, opt-in per charity, Release 3+. Not the core (the core is donated *time*). |

## 4. What is MVP-blocking vs later

**Blocking (must be designed/built in Release 1):**
- The **decision** (this document).
- A **plans + entitlements** foundation so features gate on entitlements, not hardcoded flags (US-10.1).
- **Free-by-default** onboarding with enforced Starter limits (US-10.2).
- The **integrity guardrails** as explicit, testable rules (US-10.7) — because they constrain scoring/discovery/commitments code being written *now*.

**Not blocking (Release 2+):**
- Actual **payment collection, subscriptions, invoicing** (US-10.4) — all MVP corporations run on Starter/trial, so no billing integration is needed to prove the loop.
- Seat management, upgrade flows, admin plan/pricing tooling (US-10.5, US-10.3, US-10.10).

This is the key insight: **decide and scaffold now, charge later.** Building the loop without an entitlements seam would force a painful retrofit; charging on day one would delay validating the product.

## 5. Architectural consequence

Add a **Billing & Entitlements** bounded context to [`ARCHITECTURE.md`](./ARCHITECTURE.md):
- `plans(id, code, name, ...)`, `subscriptions(organisation_id, plan_id, status, ...)`, `entitlements(organisation_id, feature, limit, ...)`.
- A middleware/policy check `hasEntitlement(org, feature)` that other modules call — feature-gating is centralised, never scattered.
- Emits `SubscriptionChanged`; consumed by Notifications and any entitlement caches.
- Payment-provider integration (e.g. Stripe) is a Release 2 adapter behind this module — absent in MVP.

## 6. Open items

- **Price points & seat counts (`N`)** — deliberately left as ranges; need market validation with target corporates before numbers are set.
- **Grant strategy** — which foundations/funders, and how grant income is tracked, is a go-to-market question outside the product backlog.
- **Non-profit-owned corporations / edge cases** — how to classify a social enterprise that is both beneficiary and deliverer. Handle at verification (US-1.3) time.
