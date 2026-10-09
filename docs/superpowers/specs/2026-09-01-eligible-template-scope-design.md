# Eligible-Template Scope (US-11.12) — Design

**Story.** *As a Platform Admin, I want agent delivery limited to an allow-list of project templates so that we only attempt project shapes the agents can deliver reliably.*

**AC.** *Given a funding attempt, when the project does not match an allow-listed template, then it is not eligible for agent delivery; the allow-list widens only as evals prove new shapes.*

## What is actually missing

Today `computeBudgetSchema` pins `templateCode: z.enum(['static-site'])`. That checks **the string the funder sent**, not **whether the project matches it**. A construction appeal or a legal-advice project can be funded for `static-site` delivery right now, and the agents will dutifully try to build it — precisely the failure the story exists to prevent.

The AC's subject is the *project*: "when **the project** does not match an allow-listed template". So the check has to compare a template against the project it would deliver, not against a list of legal strings.

The allow-list is also duplicated in three places that can drift apart: the zod enum in `commitments/service.ts`, `TEMPLATES` in `FundAgentDeliveryForm.tsx`, and `TEMPLATE_LABEL` in the project page. One registry replaces all three.

## The registry

`src/modules/agent-delivery/templates.ts` becomes the single source of truth. AgentDelivery owns it because it owns what the agents can actually build.

```ts
{
  code: 'static-site',
  label: 'Static site',
  eligibleCategories: ['software', 'design', 'marketing'],
  provenBy: '...eval evidence...',
}
```

`eligibleCategories` is the matching rule. A project's `category` is the only shape signal the domain has — it is required at publish (US-2.6), and funding only happens on published projects, so it is always present at the point of the check. `digital_resource_needs` was considered and rejected as the signal: it describes donated *inputs* (cloud credits, seats), not the deliverable.

The zod enum is derived from the registry, so the schema and the allow-list cannot drift. The funding form and the project page read their options and labels from it too.

## Why the allow-list is code, not an admin toggle

US-11.5 gave platform admins a runtime brake, so a runtime allow-list is the obvious parallel — and it is the wrong shape here. The AC's second clause is a governance rule: *"the allow-list widens only as evals prove new shapes."* A toggle in an admin UI is precisely a way to widen the list **without** evals, at 2am, under pressure. Keeping the registry in code means widening it is a pull request that carries its eval evidence in `provenBy` and gets reviewed.

Admins still need visibility, so `GET /api/admin/agent-delivery/templates` returns the registry — what is allowed, for which categories, and on what evidence. Read-only by design.

## Enforcement

At the funding choke point, `fundComputeBudget`, after the project loads and its `published` status is checked:

```
assertTemplateEligible(templateCode, project.category)
```

`getProjectRef` gains `category` (it returns a narrow column set today). The new `TemplateNotEligibleError` carries code `template_not_eligible` → **422**, matching `invalid_work_email` and `project_validation`: the request is well-formed, but this project cannot be delivered by that template. A 400 would wrongly suggest a malformed body, and a 409 a temporary state conflict — this is neither.

Funding is the right and only choke point. Acceptance (`acceptComputePledge`) inherits the template from a pledge that already passed the gate, and re-checking there would let a registry change strand pledges the platform already accepted.

## UI

The project page computes the eligible templates for its category on the server. The corporation sees a funding form only when at least one template can deliver the project; otherwise it sees a short line saying agent delivery is not available for this kind of project. Rejecting after the click is a worse experience than not offering the button, and the 422 remains as the enforced backstop for direct API calls.

## Out of scope

Widening the allow-list itself (that is an eval exercise, not a code change); per-charity or per-corporation overrides; template versioning; matching on anything richer than category; a runtime-editable allow-list, for the reason argued above.

---

## Live-verification outcome (2026-09-01)

Driven against the real stack with the seeded accounts. Three projects were published by Helping Hands — one `software`, one `construction`, one `legal` — and Globex attempted to fund each.

| Attempt | Result |
|---|---|
| `software` + `static-site` | **200** `{"ok":true,"computePledgeId":"efcf5076-…"}` |
| `construction` + `static-site` | **422** `template_not_eligible` — *"Agent delivery with the "static-site" template is not available for construction projects."* |
| `legal` + `static-site` | **422**, same shape, naming `legal` |
| `software` + `mobile-app` | **400** validation — *"Expected 'static-site', received 'mobile-app'"* |

This is the behaviour the story asked for and the codebase did **not** have before: the construction and legal attempts were accepted by the old `z.enum(['static-site'])`, because it only ever checked the string the funder sent.

The admin view returns the registry with its evidence, and is refused to everyone else:

```
GET /api/admin/agent-delivery/templates   admin → 200
  {"templates":[{"code":"static-site","label":"Static site",
    "eligibleCategories":["software","design","marketing"],
    "provenBy":"Epic 11 Slice 3a/3b: …"}]}
GET /api/admin/agent-delivery/templates   corporation → 403
```

In the UI, the corporation is offered the funding form on the software project and, on the construction project, gets the explanatory line instead of a form it could only fail with.

**One defect found and fixed during verification.** The first contract-test run returned **400** where the design called for 422: `template_not_eligible` had never been added to `DOMAIN_STATUS` in `src/lib/http.ts`, so `errorResponse` fell through to its `?? 400` default. Registering the code fixed it. The domain tests could not have caught this — it only exists at the HTTP boundary.

**Gate at verification time:** typecheck, lint and `format:check` clean; **128 unit tests / 26 files**, coverage **96.25 stmts / 92.91 branch**; **198 integration tests / 34 files**; `build:workers` (`grep -c argon2 dist/worker.cjs` = 1) and `build` clean, with `/api/admin/agent-delivery/templates` in the route manifest.

US-11.12 verified end to end.
