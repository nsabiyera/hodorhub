# Completion & Shareable Outcome (US-7.3) — Design

**Story.** *As a Charity Owner, I want to mark a project complete with an outcome story so that supporters and corporations see the result and share it socially.*

**No acceptance criteria existed.** Every Epic 7 story is a bare As-a/I-want/so-that — the only stories in the backlog without ACs. Proposed for US-7.3, and added to the backlog as part of this slice:

- **Given** a project in delivery, **when** I complete it, **then** an outcome story is required — completion without one is refused, and there is no other route to `completed`.
- **Given** a completed project, **when** anyone views its public page, **then** the outcome story is shown, along with when it completed.
- **Given** a completed project, **when** its link is shared on Facebook or X, **then** the preview card leads with the outcome, not the original appeal (extends US-3.1).
- **Given** a completed project, **when** I try to edit or re-complete it, **then** it is refused — the outcome is a published record.

## Why completion is its own operation

`transitionProjectStatus` already moves `in_delivery → completed`, and today that is a status flip carrying no result at all. Completion is the one transition that produces **new content**, so it cannot be expressed by a route whose whole body is `{ to }`.

So completion becomes `completeProject(actingUserId, projectId, outcomeStory)` with its own `POST /api/projects/[id]/complete`, and `'completed'` is **removed from the generic transition route's enum**. One way in, and it always carries a story. Leaving the old path open would let a caller complete without an outcome and quietly defeat the story — the ACs above are only true if this door is closed.

The generic domain function still refuses `to: 'completed'` with a message naming `completeProject`, so a programmatic caller gets a useful error rather than a silent bypass.

## Schema

Two nullable columns on `projects`:

- `outcome_story` (text) — the result, written once at completion.
- `completed_at` (timestamptz) — when, mirroring how `published_at` records first publish.

Nullable because every project that exists today has neither. `completed_at` is set only by `completeProject`, so it is never reset by the `in_delivery → published` reopen path — the same rule `published_at` follows for first publish.

## Validation

The story must be substantive: at least 30 characters after trimming, consistent with publish requiring a 20-character description and a 10-character goal. An empty or whitespace story is refused with `ProjectValidationError` (`project_validation` → 422), which the publish path already uses for the same class of "you have not given us enough to show anyone".

## Sharing

`generateMetadata` (US-3.1) currently uses `goal ?? description` for every state. For a completed project it leads with the outcome story instead, so a shared link shows what was achieved rather than what was once needed. Truncated for card limits; the page itself shows the whole story.

## Events

Completion emits `ProjectCompleted` alongside the existing `ProjectStatusChanged`, carrying the project, charity org and the story. Nothing consumes it yet — the corporations who delivered are the obvious audience, but notification fan-out belongs with US-8.x, and supporter alerts with US-4.4. Emitting it now means those consumers are additive later, matching how `RunClosed` was emitted before Billing existed.

## Out of scope

Editing an outcome after completion; media or images on the outcome (US-2.3); notification fan-out to supporters or corporations; the impact numbers that surround the story (US-7.2) and their cross-project aggregate (US-7.1) — both read the data this slice creates.

---

## Live-verification outcome (2026-09-01)

Driven against the real stack with the seeded accounts, completing "Litter-pick signup site" (Helping Hands, `in_delivery`).

| Attempt | Result |
|---|---|
| Story of 5 characters | **400** — *"String must contain at least 30 character(s)"* |
| `{"to":"completed"}` on the old transition route | **400** — *"Expected 'draft' \| 'published' \| 'in_delivery' \| 'archived', received 'completed'"* |
| The funding corporation completing | **404** |
| Charity owner with a real story | **200** `{"ok":true,"status":"completed"}` |
| Completing again | **409** |

The row shows `status=completed`, `completed_at` set and the story stored, and one `ProjectCompleted` event was emitted.

The **anonymous** public page renders "What this project achieved" with the story — so supporters see the result without signing in — and the share card leads with it:

```html
<meta property="og:description" content="The signup site went live in March and 412 local
volunteers registered for litter-picks in the first month, up from 40 o…">
```

The charity owner is no longer offered "Mark complete" on the completed project.

All four proposed acceptance criteria hold. **Gate:** typecheck, lint, `format:check` clean; **128 unit / 26 files** (cov 96.25/92.91); **211 integration / 35 files**; `build` clean with `/api/projects/[id]/complete` in the route manifest.

No defects found. US-7.3 verified end to end.
