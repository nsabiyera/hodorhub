# Delivery workspace, tasks & progress — design (US-6.3, US-6.4)

*2026-09-03. Bounded context: `src/modules/delivery`.*

## What this slice is

`delivery_workspaces` has existed since US-6.1 as little more than a join row
(project + accepted pledge) that allocations and hour logs hang off. US-6.3 asks
for it to become a place two organisations actually collaborate: **tasks and
milestones**. US-6.4 asks for the charity's read of it: **progress against the
project's goal**.

Both stories shipped without acceptance criteria; the ACs agreed for this slice
are now in `PRODUCT_BACKLOG.md`.

## Scope decisions

1. **Messaging is US-8.3, not here.** US-6.3's wording bundles "tasks, milestones
   and messaging", but US-8.3 (*in-context messaging*) is a story of its own and
   the same conversation surface serves the project page and this workspace.
   Building half a messaging model here would be built twice. Recorded in the
   backlog against both stories.
2. **The charity owns milestones; the corporation owns task movement.** Only the
   charity owner may create a milestone or mark it *achieved*. This is the same
   invariant the codebase already holds twice — hours are *pending* until the
   employer approves (US-6.2a), a gift is *provided* until the charity confirms
   *received* (US-6.5). The party that does the work never declares the work
   done. A milestone whose tasks are all `done` therefore reads *awaiting
   confirmation*, a **derived** state, not a stored one — nothing silently
   promotes itself.
3. **Assignment is by allocation, not by user.** `delivery_tasks.assigned_allocation_id`
   references `allocations`, so "the assignee is a volunteer allocated to *this*
   workspace" is true by construction rather than by a check that can be
   forgotten. Charity-side work is not tracked as tasks in this slice: the
   charity sets the milestones and confirms them, the corporation delivers
   against them.
4. **Progress lives in Delivery, not Reporting.** Three of its four inputs
   (tasks, milestones, hours) are Delivery's own tables; the fourth is the
   project's `goal`, read through the Projects barrel. Reporting stays what
   US-7.2 made it — the *retrospective* read that composes several contexts.
   Progress is operational and belongs with the tables it reads.
5. **Agent delivery is not merged in.** Agent runs have their own panel and
   their own impact line (US-7.2); folding them into human-delivery progress
   would be exactly the conflation US-11.9 forbids.

## Data model

Two new tables, both workspace-scoped, plus two enums:

```
delivery_milestone_status = ('open', 'achieved')
delivery_task_status      = ('todo', 'in_progress', 'done')

delivery_milestones
  id, delivery_workspace_id → delivery_workspaces
  title, due_on (date, nullable)
  status delivery_milestone_status default 'open'
  achieved_at, achieved_by → users        -- set together, only by the charity owner
  created_by → users, created_at

delivery_tasks
  id, delivery_workspace_id → delivery_workspaces
  milestone_id → delivery_milestones (nullable)
  title, detail (nullable)
  status delivery_task_status default 'todo'
  assigned_allocation_id → allocations (nullable)
  completed_at (nullable), created_by → users, created_at, updated_at
```

`achieved_at`/`achieved_by` are nullable because *open* is the normal state, not
because achievement is optional — the pair is written in one update with the
status, so "achieved with no confirmer" cannot exist.

A task's `milestone_id` is nullable on purpose: real delivery starts with loose
tasks before anyone has drawn the milestones, and the progress read shows those
separately rather than pretending they belong to a phase.

## Authorisation

One new internal helper, `workspaceParticipant`, replaces the ad-hoc
`corpForWorkspace` + `assertCsrManager` pairing for the new reads:

| Actor | Read board / progress | Create task | Move task | Create / achieve milestone |
|---|---|---|---|---|
| Charity owner (of the project) | ✅ | ✅ | ✅ any | ✅ |
| CSR manager (of the pledging corp) | ✅ | ✅ | ✅ any | ❌ 403 |
| Allocated volunteer | ✅ | ❌ 403 | ✅ own only | ❌ 403 |
| Corp member, not allocated | ✅ | ❌ 403 | ❌ 403 | ❌ 403 |
| Anyone else (incl. platform admin) | **404** | 404 | 404 | 404 |

404-not-403 for outsiders matches the rest of the codebase: a stranger learns
nothing about whether a workspace exists. Platform admin ≠ participant, the same
call made in US-7.1.

## HTTP surface

| Route | Story |
|---|---|
| `GET  /api/workspaces/[id]` | US-6.3 — the shared board (milestones + tasks + hour totals) |
| `POST /api/workspaces/[id]/tasks` | US-6.3 — charity owner or CSR manager adds a task |
| `PATCH /api/tasks/[id]` | US-6.3 — status and/or assignment |
| `POST /api/workspaces/[id]/milestones` | US-6.3 — charity owner only |
| `POST /api/milestones/[id]/achieve` | US-6.3 — charity owner only |
| `GET  /api/projects/[id]/progress` | US-6.4 — charity owner's progress read |

`/api/agent-milestones/*` already exists for run gates, so plain `/api/milestones/*`
is unambiguous and symmetric.

`GET /api/projects/[id]/progress` returns `{ inDelivery: false }` rather than an
empty board when no workspace exists (US-6.4's last AC) — an empty board would
read as "0% done", which is a different and misleading claim.

## UI

One page, `/workspaces/[id]`, server-rendered like the rest: the goal at the
top, milestones as columns of tasks with their status and due date, the
three-figure effort panel (allocated capacity · approved · pending) kept
visually separate so no one can read them as a single total, and the
charity-only actions rendered only for the charity owner.

## Deliberate non-behaviours

- **Confirmation is a decision, not a computed state.** A milestone the charity
  has confirmed stays `achieved` even if a task under it is later reopened or a
  new task is added; the board still shows the true task counts. Recomputing the
  status would let either side silently un-say something the charity said.
- **The charity may confirm before every task is ticked.** Real delivery does
  not always map onto the board, so `readyToConfirm` steers the prompt
  ("Confirm achieved" vs "Confirm achieved anyway") rather than gating the
  action. What the domain refuses is the *corporation* confirming, ever.
- **Volunteer identity is not shared across the two organisations.** A user has
  no name field yet (US-1.5 owns that), and a corporation's employee roster is
  not the charity's data: the corporation's board labels its own allocations
  with the email Identity already holds, the charity's board shows
  `Volunteer 1..n`. The CSR manager needs to know who they are assigning to;
  the charity only needs to see the work spread across people.

## Live verification (2026-09-03)

Driven end to end against a running dev server + Postgres, as the seeded
charity (Helping Hands), corporation (Globex), an allocated volunteer, and a
platform admin. Every status below is what the running app actually returned.

| Step | Result |
|---|---|
| charity publishes a project with a goal, corp pledges, charity accepts | 201 / 200 / 201 / 200 |
| `GET /projects/{id}/progress` (charity) | 200, `inDelivery: true`, names the workspace |
| `POST /organisations/{corp}/members` (a new hire) | **402 `seat_limit_reached`** — Globex's 5 Starter seats were already full from the US-10.7 verification, so US-10.7 is still live; the drive used a volunteer who already held a seat |
| `POST /workspaces/{id}/allocations` | 201 |
| `POST /workspaces/{id}/milestones` as the **corporation** | **403** `Only the charity that owns this project can do this.` |
| …as the charity | 201; a second with a past due date 201 |
| …with `dueOn: "01/09/2026"` | **400** (schema, not a domain error) |
| `POST /workspaces/{id}/tasks` as corp / as charity | 201 / 201 |
| …assigned to an allocation on another workspace | **409 `invalid_state`** `That volunteer is not allocated to this workspace.` |
| volunteer `PATCH /tasks/{own}` `status: done` | 200 |
| volunteer `PATCH /tasks/{unassigned}` | **403** `You can only move a task assigned to you.` |
| volunteer `PATCH /tasks/{own}` reassigning it | **403** `Only the charity owner or the CSR manager can do this.` |
| board after the last task moved to `done` | `status: "open"`, `readyToConfirm: true`, `overdue: true` — done work is **not** achieved |
| `POST /milestones/{id}/achieve` as the corporation | **403** |
| …as the charity / a second time | 200 / **409** `Milestone already achieved.` |
| corporation's board | volunteer labelled `dana@globex.test`, `canManageMilestones: false` |
| charity's board | same milestone, volunteer labelled `Volunteer 1` — the corporation's roster stays the corporation's |
| `GET /projects/{id}/progress` (charity) | goal echoed; `{total: 2, achieved: 1, awaitingConfirmation: 0, overdue: 1}`; `unscheduledTasks {todo: 1}`; `effort {allocatedHoursPerWeek: 4, approvedHours: 0, pendingHours: 0}` — three figures, never one |
| `GET /projects/{id}/progress` as the corporation | **404** |
| `GET /workspaces/{id}` as a platform admin / anonymously | **404** / **401** |
| worker relay | volunteer got `delivery_task.assigned`, CSR manager got `delivery_milestone.achieved` |
| `/workspaces/{id}` page, charity / corp / volunteer / admin | 200 / 200 / 200 / **404**; the charity-only actions render for the charity only |

**Two things the drive found that the tests had not.** The migration had silently
not applied to the dev database, so `GET …/progress` was a 500
(`relation "delivery_milestones" does not exist`) — the tests run against their
own migrated database and could not have caught it. And the participation 404
test was passing *vacuously*: an outsider was being rejected by a downstream
`listMembers` read raising its own `NotFoundError`, not by the participation
check. The test now asserts the message (`Delivery workspace not found.`) and was
**proved to fail** with the check removed, alongside the charity-only milestone
guard and the allocation-scope guard, each of which was broken deliberately for
one run and restored.
