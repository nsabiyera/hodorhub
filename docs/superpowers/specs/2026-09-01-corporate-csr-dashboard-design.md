# Corporate CSR Dashboard (US-7.1) — Design

**Story.** *As a CSR Manager, I want a dashboard of total donated hours, projects supported and outcomes so that I can report our social impact internally and externally.*

ACs agreed 2026-09-01, along with the four Epic 7 decisions (free for now, no export, all-time, charity sees no compute currency — the corporation sees its **own** spend, which is its own commercial data).

## Two unit systems, deliberately not reconciled

The dashboard has two sections that are never added together:

- **Donated time** — approved hours, volunteers, projects supported, gifts received.
- **Agent-delivered projects** — runs completed, £ spent of £ committed.

There is no combined "total impact" figure, and there is no attempt to express compute spend as an hours-equivalent. Epic 11 is explicit that agent delivery is a parallel path to human donated time, "reported separately — not a replacement for it", and US-11.9 forbids compute money buying merit. A dashboard that summed them would quietly undo both.

## Org scoping is enforced by the reads, not the composer

The riskiest defect for this story is another corporation's numbers leaking into a total. So scoping is not a filter the composer applies — it is a property of every read it calls. Each org-scoped read re-checks CSR membership of `corporationOrgId` against the database and filters on it:

`listPledgesForCorpOrg`, `listComputePledgesForCorpOrg`, `listResourceGiftsForCorpOrg` (Commitments); `getCorporateHours` (Delivery, resolving workspaces through the corporation's own pledge ids); `getRunsForCorporation` (AgentDelivery).

The regression test that matters delivers a **rival corporation's 40 approved hours on the same charity** and asserts the dashboard still reports 5 — the number that would change first if scoping regressed.

## Reporting still owns no tables

Every new read lives in the module that owns the data, not in Reporting. `boundary.test.ts` continues to enforce it: no schema import, no direct query, no reaching past a module barrel. `getProjectSummaries` is the one deliberately unauthorised read — it returns title, status and the already-public outcome for ids the caller supplies, exactly like `getProjectRef`, and the caller has established entitlement by having pledged to them.

## Page

`/dashboard`, server-rendered, CSR-manager-only (others redirect). Pending hours appear as an explicit "not counted above" line rather than being hidden, so the headline is honest without discarding information.

## Out of scope

Export, date ranges, entitlement gating (all deferred by the Epic 7 decisions), per-volunteer breakdowns (US-7.4) and recognition badges (US-7.5).

---

## Live-verification outcome (2026-09-01)

Driven against the real stack as the seeded Globex CSR manager.

```
GET /api/organisations/<globex>/impact   -> 200
projectsSupported: 6
hours            : {'approvedHours': 5, 'pendingHours': 3, 'volunteerCount': 1}
gifts            : {'receivedCount': 0, 'awaitingConfirmationCount': 0, 'promisedCount': 0}
agentDelivery    : {'runCount': 5, 'completedRunCount': 4,
                    'committedMinor': 1150000, 'consumedMinor': 13, 'currency': 'GBP'}
outcomes         : ['Litter-pick signup site']
```

Access:

| Viewer | Endpoint | `/dashboard` |
|---|---|---|
| CSR manager (own org) | **200** | **200** |
| Charity owner | **404** | **307** redirect |
| Platform admin (not a member) | **404** | — |
| Anonymous | **401** | **307** redirect |

Note the platform admin gets 404: this dashboard is the corporation's own commercial reporting, and admin rights over the platform are not membership of the company.

The page renders four sections — Donated time, Agent-delivered projects, Outcomes, Projects supported — and the two unit systems stay visibly apart:

```
5      approved hours          4      completed of 5 runs
6      projects supported      £0.13  compute spent of £11,500.00 committed
1      volunteers
```

There is no combined figure anywhere on the page. The honesty line renders beneath the headline: *"3 hours logged but not yet approved — not counted above."* The one completed project's outcome story appears under Outcomes, ready to quote.

**Gate:** typecheck, lint, `format:check` clean; **130 unit / 27 files** (cov 96.25/92.91); **230 integration / 37 files**; `build` clean with `/dashboard` and `/api/organisations/[id]/impact` in the route manifest.

No defects found. US-7.1 verified end to end — **Epic 7's three Should-stories are complete.**
