# Design — Resource-gift front-end forms

**Date:** 2026-07-14
**Status:** Approved design, ready for implementation planning
**Depends on:** the merged in-kind resource gifts backend (`docs/superpowers/specs/2026-07-14-in-kind-resource-gifts-design.md`) — schema, services, and API routes already exist.

## 1. Summary

Build the front-end forms that let charities and corporations actually use the
resource-gift API, which today has no UI. All forms live on a now **role-aware**
project detail page (`/projects/[id]`). Anonymous and unrelated viewers see
today's public page unchanged, plus one new read-only panel. The charity owner
of the project and a CSR manager of a verified corporation each see role-gated
forms. This is the first authenticated, role-aware project UI in the app.

## 2. Role model on the detail page

The page is currently public (`getPublishedProject`, no session). It gains:

- `getSession()` (from `@/lib/auth`) → the viewer's `userId` or null.
- Viewer-membership resolution via a new `identity.getUserOrg(userId)` (see §4).
- Charity-owner detection: the viewer is the charity owner of THIS project iff
  `findMembership(userId, project.charityOrgId).role === 'charity_owner'`
  (`project.charityOrgId` is on the `getPublishedProject` result).
- CSR-manager detection: `getUserOrg(userId)` returns
  `{ organisationId, role, orgType, status }`; the offer form renders only when
  `role === 'csr_manager'` AND `orgType === 'corporation'` AND
  `status === 'verified'` (mirrors the server-side gate — no false affordance).

A viewer is only ever in one of these roles (MVP: one membership per user).
Platform admins and unrelated users get the public view + read-only needs panel.

## 3. Sections rendered

**Everyone (incl. anonymous):** a read-only *"Digital resources needed"* panel,
built like the existing "Help needed" panel, listing each digital-resource need
(`kind` humanised, optional `quantity`+`unit`, optional `description`). Shown
whenever the project has digital-resource needs.

**Charity owner of this project:**
- *"Edit digital resources needed"* — a replace-all editor: rows of `kind`
  (select over `DIGITAL_RESOURCE_KINDS`) + optional quantity + unit + description;
  submit → `PUT /api/projects/[id]/digital-resource-needs` with `{ needs: [...] }`.
- *"Gift offers"* — lists every gift on the project (via
  `listResourceGiftsForProject`) with status shown distinctly and actions:
  **accept / decline** when `offered` (decline captures a reason),
  **confirm received** when `provided`. Terminal states (`declined`,
  `received`, `withdrawn`) are shown without actions.

**Verified corp's CSR manager:**
- *"Offer a resource gift"* — `kind` select + optional quantity + unit + note,
  optionally targeting one of the project's listed digital-resource needs;
  submit → `POST /api/projects/[id]/resource-gifts` with
  `{ corporationOrgId, needId?, kind, quantity?, unit?, note? }`. The
  `corporationOrgId` comes from `getUserOrg`, never typed by the user.
- *"Your offers"* — lists this corp's gifts on the project (via new
  `listResourceGiftsForCorp`) with status and actions: **mark provided** when
  `accepted`, **withdraw** (captures a reason) while `offered|accepted|provided`.

## 4. Backend reads to add

Both are read-only additions; no change to the existing gift write-paths.

1. **`identity.getUserOrg(userId, db?)`** → `{ organisationId: string; role:
   MemberRole; orgType: 'charity' | 'corporation'; status: 'pending' |
   'verified' | 'rejected' } | null`. Resolves the viewer's single membership
   joined to its organisation. Returns null if the user has no membership
   (e.g. a platform admin or a supporter-only account). Exported from
   `@/modules/identity`.
2. **`commitments.listResourceGiftsForCorp(actingUserId, projectId,
   corporationOrgId, db?)`** → the corp's gifts on the project. Asserts the
   acting user is a `csr_manager` of `corporationOrgId` (reuse
   `assertCorpManager`), then returns `resource_gifts` rows where
   `projectId` and `corporationOrgId` match. Exported from
   `@/modules/commitments`. (The existing `listResourceGiftsForProject` is
   charity-owner-gated and returns ALL gifts, so it cannot serve the corp view.)

## 5. Client components (mirror `SupportButton`: `'use client'`, `useState`, `fetch`, handle 401, disable while busy, full navigation/refresh on success)

- **`DigitalNeedsEditor({ projectId, initialNeeds })`** — add/remove need rows,
  submit the full set (replace-all). On success, `window.location.reload()` so
  the server re-renders the read-only panel + editor from fresh data.
- **`OfferGiftForm({ projectId, corporationOrgId, needs })`** — the offer form;
  `needs` populates an optional "toward which need" select. On success, reload.
- **`GiftActions({ gift, perspective })`** where `perspective: 'charity' |
  'corp'` decides which buttons show for the gift's current status. Buttons POST
  to `/api/resource-gifts/[id]/{accept,decline,provided,received,withdraw}`;
  decline & withdraw collect a reason via a small inline text input before
  POSTing. On success, reload. Handles 401 by prompting sign-in.

## 6. Styling

Reuse the existing GoT design system in `globals.css`: `.panel`, `.need`,
`.detail-line`, the `.auth-form`/`.auth-field` input styles, and the `.btn`
button. Add a compact `.gift-*` set only where needed (a gift row, a status
chip, an inline reason input, a secondary/ghost button variant). Extend the
established look; do not introduce a new aesthetic.

## 7. Out of scope

- **Draft-project needs editing** — no draft-editing UI exists; the editor and
  offer form appear on **published** projects only (the detail page only loads
  published projects anyway).
- No new top-level routes or dashboard; everything hangs off `/projects/[id]`.
- No pledge (donated-time) UI — this slice is resource gifts only.
- No changes to the gift write-path services or their API routes.

## 8. Verification

- `npm run typecheck`, `npm run lint`, `npm run build` green.
- New backend reads covered by tests (`getUserOrg`, `listResourceGiftsForCorp`).
- **Drive each role in the browser** (headless Chrome screenshots, per the
  screenshot-workflow note): anonymous view (unchanged + read-only needs),
  charity-owner view (needs editor + gift offers with accept/decline/confirm),
  corp CSR-manager view (offer form + your-offers with provided/withdraw). A
  role affordance must never appear for a viewer the server would reject.
