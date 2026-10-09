# Design — In-kind digital resource gifts ("companies can donate tokens")

**Date:** 2026-07-14
**Status:** Approved design, ready for implementation planning
**Authors:** Product Owner + Software Architect (brainstorm), synthesised

## 1. Summary

Companies can donate **in-kind digital resources** to software projects — the
non-human things a software project consumes: cloud credits (AWS/GCP), API/LLM
budget (e.g. OpenAI), SaaS seats/licences (GitHub, Figma), hosting, and domains.

A charity declares a **digital-resource need** on a project (alongside its
existing skill/role/hours needs). A corporation fulfils it through an
**offer → accept/decline → provided → received** flow that mirrors the existing
pledge and approved-hours shapes. HodorHub **records and coordinates an
off-platform gift** — exactly as it records donated hours. It transfers nothing,
provisions nothing, and puts no monetary value on anything.

This is a third contribution channel into the **core delivery loop**, not a new
monetisation surface. The user-decided meaning of "token" is *in-kind digital
resource* — explicitly **not** money, **not** paid ranking, **not** tokenised
hours. In the UI the feature is called an **in-kind resource gift**; "token" is
informal shorthand only.

## 2. Who benefits

- **Charity.** Many software projects stall not for lack of a developer but for
  lack of a $300 cloud bill or three GitHub seats. Today a charity can attract
  *time* but has no structured way to ask for the *substrate* that time runs on.
  This unblocks delivery.
- **Corporation.** A firm with unused enterprise cloud credits, spare SaaS
  seats, or vendor allowances can contribute at near-zero marginal cost — an
  on-ramp for companies who cannot spare developer hours this quarter but can
  spare a licence. Broadens who can participate in delivery.
- **Supporter.** Indirect only (a better-resourced project is likelier to
  succeed). Supporters get **no** new action here — a supporter-facing surface
  would be gold-plating and is out of scope.

## 3. Principle alignment

The four non-negotiable principles (`MONETISATION_MODEL.md` §1):

- **P1 — charities/supporters never pay:** reinforced; the charity *receives*.
- **P2 — corporations fund the platform via SaaS:** no conflict, with a nuance —
  a gift is a corporation giving to a *charity*, not funding *HodorHub*. It sits
  on the generosity/delivery side with donated hours, never the monetisation
  side. It must never become a paid feature, a billable transaction, or
  something HodorHub takes a cut of (the "cut of donated value" model is already
  rejected as toxic, `MONETISATION_MODEL.md` §3).
- **P3 — merit is never for sale:** the sharp edge. A large gift will create
  pressure to nudge a project's rank, grant discovery preference, or brand the
  neutral marketplace ("Powered by AcmeCloud"). **All three are blocked.** A gift
  has zero effect on support score, zero effect on discovery rank, zero effect on
  the charity's freedom to decline, and no branding presence on the shared
  marketplace. This is made **structural** (§6) and asserted by a guardrail test
  (US-RG, §7).
- **P4 — approved-only counts:** maps cleanly onto a **provided → received**
  distinction that mirrors pending/approved hours; "promised" is never shown as
  "delivered".

## 4. Lifecycle — charity-PULL, coordination-only

**Charity-PULL (decided), not company-PUSH.** A charity declares a need that a
company fulfils — reusing the whole platform grain ("public/charity signals
demand, corporations respond"). A company-pushed *offers marketplace* is a
corporate-inventory catalogue that invites branded storefronts, "featured
donors", and a second ranking surface — all pulling against P3 and marketplace
neutrality. It is deferred (Release 2+), decided on evidence, not assumed.

**Coordination, not custody (decided).** HodorHub records that a gift was
offered, accepted, and later provided/received. It does not transfer credits,
provision seats, or call any vendor API. Identical stance to donated hours: the
value moves off-platform; we record the commitment and the confirmation. This
keeps HodorHub out of payments, provisioning, tax, and liability, and carries
**no financial risk**.

**State machine** (mirrors US-5.3 accept and the US-6.2a pending→approved shape):

```
offered ──charity accepts──▶ accepted ──corp marks provided──▶ provided ──charity confirms──▶ received
   │                            │                                  │
   └── charity declines ────────┴──────── corp withdraws ──────────┘   → declined / withdrawn
```

- **Accept/decline** is US-5.3 unchanged: the charity_owner accepts or declines,
  with a required reason on decline. Absolute charity control is preserved.
- **Admin verification: none at MVP (decided).** Trust is bounded by the
  two-sided verified-actor gate (US-1.3 — verified corp + charity_owner) plus the
  charity's confirmation of receipt (the charity is the party who knows whether
  the resource actually arrived). Revisit only if abuse appears.

## 5. Data model

Two **new sibling tables** — reuse the *patterns* of `pledges` /
`project_resource_needs`, not the tables themselves. Rationale in §8.

New enums (drizzle `pgEnum`, matching `schema.ts` conventions):

```
resource_gift_kind   = ['cloud_credits','api_budget','llm_budget','saas_seats','hosting','domains','other']
resource_gift_status = ['offered','accepted','declined','provided','received','withdrawn']
```

**Projects module** — sibling to `project_resource_needs`:

```
digital_resource_needs(
  id           uuid pk default random,
  project_id   uuid not null → projects.id,
  kind         resource_gift_kind not null,
  description  text,                 -- "GPU credits for model training"
  quantity     integer,              -- OPTIONAL (coordination-only)
  unit         text,                 -- OPTIONAL free string: "USD credits", "seats"
  created_at   timestamptz not null default now()
)
```

**Commitments module** — sibling to `pledges` (NOT a `kind` on it):

```
resource_gifts(
  id                 uuid pk default random,
  project_id         uuid not null → projects.id,
  corporation_org_id uuid not null → organisations.id,
  need_id            uuid → digital_resource_needs.id,   -- NULLABLE (PULL default; PUSH-ready)
  kind               resource_gift_kind not null,
  quantity           integer,                            -- optional
  unit               text,                               -- optional string; NO currency/amount column
  note               text,
  status             resource_gift_status not null default 'offered',
  decided_by         uuid → users.id,                    -- charity user who accepted/declined/confirmed
  provided_at        timestamptz,
  received_at        timestamptz,
  reason             text,                               -- decline/withdraw reason
  created_at         timestamptz not null default now()
)
```

Deliberate divergences from `pledges`, each defensible:

- **No single-accept unique index.** Many gifts per project is a feature
  (cloud credits from A + LLM budget from B, co-existing with a time pledge).
  `pledges` has `pledges_one_accepted_per_project`; a gift must not inherit it.
- **No delivery FK, no workspace.** Accepting a gift never creates
  `delivery_workspaces` / `allocations` / `hour_logs`. It is a claim record, not
  a delivery commitment.
- **Isolated status enum** so `provided`/`received`/`withdrawn` never pollute
  `pledgeStatus` and force dead branches in delivery/notification switches.
- **No £/amount/custody columns.** Coordination-only is enforced by the
  *absence* of these columns, not by convention.

Transitions use the compare-and-set-on-`status` pattern already used by
`transitionProjectStatus` (`projects/service.ts`) so retries and concurrent
actors can't double-advance a gift.

## 6. Events and the structural merit-integrity seam

Emit to the transactional outbox in the same in-transaction pattern as
`pledgeResources`:

| Event | Emitted by | Subscribers | Reaches Scoring? |
|-------|-----------|-------------|------------------|
| `ResourceGiftOffered` | Commitments | Notifications (→ charity_owner) | No |
| `ResourceGiftAccepted` / `ResourceGiftDeclined` | Commitments | Notifications (→ csr_manager) | No |
| `ResourceGiftProvided` | Commitments | Notifications (→ charity_owner: "confirm receipt") | No |
| `ResourceGiftReceived` | Commitments | Notifications (→ csr_manager); Reporting read-model *later* | No |

These are new cases in `notifications/service.ts::dispatchEvent`, mirroring
`PledgeProposed` / `PledgeAccepted`.

**"A gift can never reach the score" is structural, four barriers (strongest first):**

1. **No subscription surface.** Scoring is a pure library
   (`engagement/service.ts` `computeScores`/`applyScores`) invoked synchronously
   in-transaction by `recomputeProjectScore`; the outbox relay
   (`notifications/relay.ts`) dispatches domain events to **Notifications only**.
   A `ResourceGift*` event has no consumer that can call Scoring — a property of
   the module graph, not a test.
2. **Closed source allowlist.** Scoring's only inputs are `on_platform_supports`
   and `engagement_events` (status `confirmed`, sources `{on_platform, facebook,
   twitter}`). Gifts live in a table that query never reads. A unit test asserts
   the source set is closed (fails if a new source is added silently).
3. **Module-boundary rule + lint.** Extend `src/modules/README.md`: the gift code
   in Commitments must not import from `scoring`/`engagement`, and
   `scoring`/`discovery` must never read `resource_gifts`. Enforce with a
   dependency-boundary check + review.
4. **Discovery exclusion.** Discovery ranks off `project_scores` + project fields
   only. `resource_gifts` never appears in a discovery `ORDER BY`/filter. A gift
   badge *may* display on a project page (like hours) but is never a sort input.

## 7. MVP slice (user stories)

### US-2.7 — Declare a digital-resource need — *Must*
**As a** Charity Owner **I want** to declare that a project needs a digital
resource **so that** corporations can fulfil the substrate my project runs on,
not only the labour.
- **Given** I am editing a project, **when** I add a resource need, **then** I can
  choose kind = *digital resource*, pick a type from a controlled list, with
  optional free-text detail and optional quantity + unit (e.g. "GitHub Team, 5
  seats"; "AWS credits, ~$500").
- **Given** a digital-resource need, **when** it displays, **then** it appears in
  the project's structured resource-needs list alongside skill/role/hours needs.
- **Given** I enter a quantity, **when** saved, **then** it is stored as a plain
  number + unit string — no monetary valuation is computed or required.

### US-5.5 — Offer an in-kind resource gift — *Must*
**As a** CSR Manager **I want** to offer to fulfil a digital-resource need
**so that** the charity knows a concrete gift is on the table.
- **Given** a published project with a digital-resource need, **when** I submit a
  resource-gift offer (kind, quantity/detail, optional note), **then** it is
  recorded with status `offered` and awaits charity acceptance.
- **Given** my offer, **when** the charity reviews it, **then** they can accept or
  decline it exactly as any pledge (US-5.3), with an optional reason on decline.
- **Given** acceptance, **when** it happens, **then** it is recorded as a
  coordinated commitment; HodorHub transfers and provisions nothing, and no
  delivery workspace is created.
- **Given** I am not a CSR Manager of a verified corporation, **when** I attempt to
  offer, **then** it is refused (verified-actor gate, US-1.3).

### US-6.5 — Confirm a gift was provided / received — *Should*
**As a** Charity Owner **I want** to confirm when a pledged resource was actually
provided **so that** "promised" is never shown as "delivered".
- **Given** an accepted resource gift, **when** the corporation marks it
  *provided*, **then** it shows as *provided (pending confirmation)*.
- **Given** a provided gift, **when** I confirm receipt, **then** it becomes
  *received*; provided vs received are always shown distinctly (mirrors
  pending/approved hours, US-6.2a).
- *Should, not Must:* the slice is demoable at accept (US-5.5). Confirmation is
  the honest completion of the loop and cheap given the hour-log pattern, but is
  the cut line if the slice must shrink.

### US-RG — Resource gifts are merit-blind and marketplace-neutral — *Must*
**As a** Platform Admin **I want** in-kind resource donations to have zero effect
on support score, discovery ranking, a charity's accept/decline freedom, or
marketplace branding **so that** generosity can never buy merit or visibility.
- **Given** any project, **when** support/momentum scores or discovery rank are
  computed, **then** resource gifts (offered, accepted, or received) are not an
  input — automated tests assert it, alongside the payment-blind tests (extends
  US-10.4).
- **Given** the neutral marketplace, **when** it renders, **then** no donor
  company's name/logo/brand appears on it as a result of a gift.

## 8. Key design decisions (resolved)

1. **Need representation:** sibling `digital_resource_needs` table, *not* a `kind`
   discriminator on `project_resource_needs`. `setResourceNeeds` is replace-all
   and validates every row with the time-shaped `resourceNeedSchema` (required
   `skill`/`role`/`hoursPerWeek`/`durationWeeks`); a digital-resource need has
   none of these. A sibling table avoids branching a replace-all over two shapes.
2. **Gift representation & module:** `resource_gifts` as a **sibling aggregate
   inside the `commitments` module**, *not* a `kind` on `pledges` and *not* a new
   bounded context. A gift is a corporate commitment against a project (same
   actors, authz, and outbox seams as pledges), so a new module would over-
   fragment; but `pledges` carries hard time-delivery semantics (the single-accept
   unique index; `acceptPledge → beginDelivery → delivery_workspaces` with a NOT
   NULL `pledge_id` FK) that a gift must not inherit, so it cannot share the table.
3. **Enum scope:** define the full `resource_gift_status` enum now (frozen to
   avoid a later migration); ship only the `offered → accepted/declined`
   transitions for the US-5.5 Must; gate `provided → received` behind US-6.5.
4. **`need_id` nullable:** default the UX to charity-PULL (offer against a
   declared need), but allow a null `need_id` so a future company-PUSH offer needs
   no schema change.
5. **Idempotency (not blocking):** natural dedupe on `(project_id,
   corporation_org_id, need_id)` while an offer is in a live state
   (`offered|accepted|provided`), rather than a client key.
6. **Rate limiting (not blocking):** reuse the existing Redis limiter, scoped per
   corp-per-project, to blunt notification-DoS / fake-offer spam.
7. **Gift display (not blocking):** a gift badge may show on a project page, never
   in a discovery sort/filter.

## 9. Deferred scope (Release 2+ / YAGNI now)

- External API auto-provisioning (AWS/GCP/OpenAI/GitHub).
- Monetary (£) valuation of gifts.
- Tax / Gift Aid receipts.
- Donor recognition badges (sibling of US-7.5; recognition is a paid-tier
  reporting story, kept out of the free core loop).
- Company-PUSH offers / inventory marketplace.
- Matching / recommendations of companies to resource needs (sibling of US-4.3).
- CSR-dashboard reporting rollups of donated resources (US-7.1 extension).
- A formal units/quantity taxonomy (free string at MVP).

## 10. Failure modes

- **Idempotency:** natural dedupe on live `(project, corp, need)`; transitions
  guarded by status checks + compare-and-set; the outbox relay is already
  idempotent (`published` flag + `FOR UPDATE SKIP LOCKED`).
- **Provided-but-not-confirmed:** rendered as *claimed/unconfirmed*, counts as
  delivered impact nowhere, no auto-confirm; optional reminder notification.
  Irrelevant to score in every state regardless.
- **Decline / withdraw:** charity declines with a required reason (mirror
  `declinePledge`); corp may withdraw while `offered|accepted|provided`, never
  after `received`; status CAS prevents accept/withdraw races.
- **Actor gates:** offer requires acting user is `csr_manager` of a *verified*
  corp and the project is in an open public state; confirmation requires
  `charity_owner` of the project's charity.
- **Abuse/spam:** because gifts are a structural zero for score/rank, the gaming
  incentive is gone. Residual vectors — notification-DoS / grandiose fake offers
  (mitigated by the Redis rate-limiter + verified-corp requirement + charity
  decline) and false "provided" claims (mitigated by charity confirm-of-receipt
  and the *unconfirmed* label). No £, no custody, no settlement ⇒ no financial
  risk.

## 11. Primary risk

The engineering cost is roughly one vertical slice (two small tables, one
service, four notification cases, one guardrail test) because we reuse patterns,
not tables. The real risk is **definitional drift**: every deferred item
(valuation, provisioning, Gift Aid) pulls "gift" toward "money". The instant
HodorHub attaches a £ figure or provisions a resource it inherits financial-
accuracy, custody, tax, and liability obligations *and* reopens the merit-
integrity attack surface (someone will try to buy rank with "generosity"). Hold
the coordination-only line; the cheap US-RG guardrail is the insurance.

## 12. Documentation hygiene (fold into the implementation)

`ARCHITECTURE.md` §8 describes Scoring as an outbox *subscriber* to
`EngagementRecorded`. The code does not work that way: Scoring is a pure library
invoked **synchronously, in-transaction** by `recomputeProjectScore`, and the
outbox relay dispatches to **Notifications only**. The divergence is harmless and
in fact *strengthens* the merit-integrity guarantee for gifts (there is no bus a
gift event could ride to the score). When implementing this feature, update
`ARCHITECTURE.md` §8 and word the US-RG guardrail so the merit-integrity claim
rests on the **actual synchronous mechanism**, not on an aspirational event bus.

## 13. Backlog changes to make when implementing

- Add **US-2.7** (Epic 2), **US-5.5** (Epic 5), **US-6.5** (Epic 6), and **US-RG**
  (Epic 10, extending US-10.4) to `PRODUCT_BACKLOG.md`.
- Add a short **Contributions/resource-gift** note to `ARCHITECTURE.md` under the
  Commitments context, plus the §8 correction above.
