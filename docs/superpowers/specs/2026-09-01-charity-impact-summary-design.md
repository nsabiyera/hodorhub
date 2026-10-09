# Charity Impact Summary (US-7.2) — Design

**Story.** *As a Charity Owner, I want an impact summary (support gathered, hours received, outcomes) per project so that I can report to trustees and funders.*

ACs were drafted and agreed on 2026-09-01 (see `PRODUCT_BACKLOG.md`), along with four Epic 7 decisions: reporting ships free for now, no export, all-time totals, and the charity sees runs and outcomes rather than compute spend.

## A new bounded context that owns nothing

Reporting is a **read-only composer**. It has no tables and never queries another context's tables: every figure comes from the owning module's public read.

That constraint is the whole design. The risk with a reporting surface is not that it is hard to build — it is that it quietly becomes a *second definition* of "hours" or "support" that drifts from the one the domain enforces. Composing `getProjectHoursForCharity` rather than summing `hour_logs` means the approved-only rule (US-6.2a) cannot be re-implemented slightly differently here.

`boundary.test.ts` enforces it structurally: no `@/db/schema` import, no `.query.*.find`, no `db.select(`, and every module import must be a bare barrel (`@/modules/x`, never `@/modules/x/service`).

## Figures that refuse to be summed

The read returns splits, not totals, wherever the domain distinguishes them:

- `approvedHours` and `pendingHours` are separate fields. There is no `totalHours`, because a trustee report that counts unapproved hours as delivered is exactly the failure US-6.2a exists to prevent.
- `receivedCount`, `awaitingConfirmationCount` and `promisedCount` are separate. A gift the corporation marked `provided` is its claim, not the charity's confirmation, so it counts toward neither delivered nor promised (US-6.5).
- `agentDelivery` is its own object, never folded into hours and never expressed as support (US-11.9, US-10.4). It carries milestones, run status and URLs — no currency, per Epic 7 decision 4.

## Authorisation

`getProjectForOwner` runs first and throws `NotFoundError` for a project outside the caller's charity, so impact data never crosses tenants and a probe cannot distinguish "not yours" from "does not exist". The route is a thin pass-through; the page requests the summary only when the viewer is the owning charity.

## Out of scope

Export (decision 2), date ranges (decision 3), entitlement gating (decision 1 — deferred to US-10.5), and the cross-project corporate aggregate (US-7.1), which will reuse this module.

---

## Live-verification outcome (2026-09-01)

Driven against the real stack. The dev database had **no hour logs at all**, so the approved/pending split — the AC that matters most — was unverifiable on existing data. A full human-delivery path was created through the API instead: publish → corporation pledges resources → charity accepts (delivery workspace) → volunteer invited and allocated → 5 h and 3 h logged → **only the 5 h approved**.

```
GET /api/projects/<id>/impact   (charity)  -> 200
hours         : {'approvedHours': 5, 'pendingHours': 3, 'volunteerCount': 1}
gifts         : {'receivedCount': 0, 'awaitingConfirmationCount': 0, 'promisedCount': 0}
agentDelivery : None
no totalHours field: True
```

Five and three, never eight — and there is no field a caller could mistake for a combined total. On the agent-delivered project completed during US-7.3 the same endpoint returns `agentDelivery` with 4 of 4 milestones approved and a staging URL, while `hours` and `support` stay at zero: agent work inflates neither.

Access, over HTTP and in the page:

| Viewer | `GET .../impact` | `impact-grid` in the page |
|---|---|---|
| Owning charity | **200** | present |
| Funding corporation | **404** | absent |
| Anonymous | **401** | absent |

The page renders "3 hours awaiting employer approval, not counted above" beneath the headline figures, so the split is visible and not merely present in the payload.

**Two false alarms during verification**, both worth recording: the pending-hours grep missed because the count sits inside `<strong>`, and "Impact summary" appeared on the corporation's page only because it was the test project's own title in the `<title>` tag. Checking the panel-specific `impact-grid` markup instead settled both — a reminder to assert on markup that only the component emits, not on prose.

**Gate:** typecheck, lint, `format:check` clean; **130 unit / 27 files** (cov 96.25/92.91); **222 integration / 36 files**; `build` clean with `/api/projects/[id]/impact` in the route manifest.

No defects found. US-7.2 verified end to end.
