# Resource-gift Front-end Forms Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Give charities and corporations a UI for the already-built resource-gift API, on a now role-aware `/projects/[id]` page.

**Architecture:** The detail page (today public + role-unaware) gains `getSession()` + viewer-membership resolution and renders role-gated sections. Client form components mirror the existing `SupportButton` (`'use client'` → `fetch` the API route → reload on success). Two small read-only backend helpers are added; no gift write-path changes.

**Tech Stack:** Next.js 15 App Router (server components + client components), TypeScript, Drizzle ORM + PostgreSQL, Vitest integration harness, the existing GoT design system in `globals.css`.

## Global Constraints

- **Role affordances must match the server gate exactly** — never render a form the server would reject. Charity-owner section iff `findMembership(userId, project.charityOrgId).role === 'charity_owner'`. Offer form iff `getUserOrg(userId)` is `{ role: 'csr_manager', orgType: 'corporation', status: 'verified' }`.
- **Anonymous / unrelated / platform-admin viewers see today's public page unchanged**, plus the one read-only "Digital resources needed" panel.
- **`corporationOrgId` is never typed by the user** — it comes from `getUserOrg`.
- **Coordination-only** — forms never collect or display a monetary value; `quantity` is an optional integer, `unit` an optional free string.
- **Client components mirror `SupportButton`** (`src/app/projects/[id]/SupportButton.tsx`): `'use client'`, `useState` for busy/message, `fetch` the route, handle `401` by prompting sign-in, disable controls while busy, and on success call `window.location.reload()` so server components re-render from fresh data.
- **Reuse the design system** — `.panel`, `.need`, `.detail-line`, `.btn`, and `.auth-form`/`.auth-field` input styles; add only a compact `.gift-*` set.
- **Published projects only** — the detail page loads only published projects (`getPublishedProject`); no draft-editing UI.
- **Verification commands** (repo root): `npm run typecheck`, `npm run lint`, `npm run build`; integration tests need BOTH env vars set or `contract.integration.test.ts` fails with a spurious SASL error:
  `export DATABASE_URL=postgres://hodorhub:hodorhub@localhost:5432/hodorhub_test`
  `export TEST_DATABASE_URL=postgres://hodorhub:hodorhub@localhost:5432/hodorhub_test`
  then `npm run test:integration`.

**Out of scope:** draft-project needs editing, any new routes/dashboard, pledge (donated-time) UI, and changes to the gift write-path services/routes.

---

### Task 1: Backend reads — `getUserOrg` + `listResourceGiftsForCorp`

**Files:**
- Modify: `src/modules/identity/service.ts` (add `getUserOrg`)
- Modify: `src/modules/identity/index.ts` (export it)
- Modify: `src/modules/commitments/gifts.ts` (add `listResourceGiftsForCorp`)
- Modify: `src/modules/commitments/index.ts` (export it)
- Test: `src/modules/identity/get-user-org.integration.test.ts`
- Test: extend `src/modules/commitments/resource-gifts.integration.test.ts`

**Interfaces:**
- Consumes: `memberships`, `organisations`, `resourceGifts` tables; `assertCorpManager` (already exported from `commitments/service.ts`); `registerCharity`/`registerCorporation`/`approveVerification`/`createPlatformAdmin` (identity) in tests.
- Produces:
  - `getUserOrg(userId: string, db?): Promise<{ organisationId: string; role: 'charity_owner'|'csr_manager'|'manager'|'volunteer'; orgType: 'charity'|'corporation'; status: 'pending'|'verified'|'rejected' } | null>`
  - `listResourceGiftsForCorp(actingUserId: string, projectId: string, corporationOrgId: string, db?): Promise<ResourceGiftRow[]>`

- [ ] **Step 1: Write the failing `getUserOrg` test** — create `src/modules/identity/get-user-org.integration.test.ts`:

```typescript
import { describe, it, expect } from 'vitest';
import { testDb } from '@/test/db';
import {
  registerCharity,
  registerCorporation,
  approveVerification,
  createPlatformAdmin,
  getUserOrg,
} from './index';

describe('Identity — getUserOrg', () => {
  it('resolves a charity owner membership + org', async () => {
    const c = await registerCharity(
      { email: 'petra@goodcause.org', password: 'a-strong-password', charityName: 'Good Cause', regNumber: 'CH-1' },
      testDb,
    );
    const org = await getUserOrg(c.userId, testDb);
    expect(org).toEqual({
      organisationId: c.organisationId,
      role: 'charity_owner',
      orgType: 'charity',
      status: 'pending',
    });
  });

  it('reflects verification status for a corporation csr_manager', async () => {
    const admin = await createPlatformAdmin('admin@hh.com', 'admin-password-1', testDb);
    const corp = await registerCorporation(
      { email: 'carlos@acme.com', password: 'a-strong-password', companyName: 'Acme', emailDomain: 'acme.com' },
      testDb,
    );
    let org = await getUserOrg(corp.userId, testDb);
    expect(org).toMatchObject({ role: 'csr_manager', orgType: 'corporation', status: 'pending' });
    await approveVerification(corp.verificationRequestId, admin, testDb);
    org = await getUserOrg(corp.userId, testDb);
    expect(org?.status).toBe('verified');
  });

  it('returns null for a user with no membership (e.g. platform admin)', async () => {
    const admin = await createPlatformAdmin('solo@hh.com', 'admin-password-1', testDb);
    expect(await getUserOrg(admin, testDb)).toBeNull();
  });
});
```

- [ ] **Step 2: Run it to verify it fails**

Run: `DATABASE_URL=postgres://hodorhub:hodorhub@localhost:5432/hodorhub_test TEST_DATABASE_URL=postgres://hodorhub:hodorhub@localhost:5432/hodorhub_test npm run test:integration -- src/modules/identity/get-user-org.integration.test.ts`
Expected: FAIL — `getUserOrg` is not exported.

- [ ] **Step 3: Implement `getUserOrg`** in `src/modules/identity/service.ts` (place it next to `findMembership`). `memberships` and `organisations` are already imported at the top of the file; `eq` is already imported.

```typescript
/**
 * Resolve a user's single membership joined to its organisation — used by the
 * app layer to role-gate UI. Returns null if the user has no membership
 * (a platform admin or supporter-only account).
 */
export async function getUserOrg(userId: string, db: Executor = defaultDb) {
  const m = await db.query.memberships.findFirst({
    where: eq(memberships.userId, userId),
  });
  if (!m) return null;
  const org = await db.query.organisations.findFirst({
    where: eq(organisations.id, m.organisationId),
  });
  if (!org) return null;
  return {
    organisationId: org.id,
    role: m.role,
    orgType: org.type,
    status: org.status,
  };
}
```

If `organisations` is not already imported in `service.ts`, add it to the existing `@/db/schema` import.

- [ ] **Step 4: Export it** — add `getUserOrg` to the export block in `src/modules/identity/index.ts`.

- [ ] **Step 5: Run the `getUserOrg` test to verify it passes**

Run: same command as Step 2.
Expected: PASS (3 tests).

- [ ] **Step 6: Write the failing `listResourceGiftsForCorp` test** — append to `src/modules/commitments/resource-gifts.integration.test.ts` (import `listResourceGiftsForCorp` from `./gifts` and `ForbiddenError`/`NotFoundError` from `@/modules/identity` if not already imported):

```typescript
describe('Commitments — listResourceGiftsForCorp', () => {
  it('returns only the acting corp’s gifts on the project', async () => {
    const { charity, corp, projectId } = await scenario();
    const admin2 = await createPlatformAdmin('admin2@hh.com', 'admin-password-1', testDb);
    const corp2 = await registerCorporation(
      { email: 'dana@beta.com', password: 'a-strong-password', companyName: 'Beta', emailDomain: 'beta.com' },
      testDb,
    );
    await approveVerification(corp2.verificationRequestId, admin2, testDb);

    await offerResourceGift(corp.userId, projectId, gift(corp.organisationId), testDb);
    await offerResourceGift(corp.userId, projectId, { ...gift(corp.organisationId), kind: 'llm_budget' }, testDb);
    await offerResourceGift(corp2.userId, projectId, gift(corp2.organisationId), testDb);

    const mine = await listResourceGiftsForCorp(corp.userId, projectId, corp.organisationId, testDb);
    expect(mine).toHaveLength(2);
    expect(mine.every((g) => g.corporationOrgId === corp.organisationId)).toBe(true);
    // charity user is not a csr_manager of the corp
    await expect(
      listResourceGiftsForCorp(charity.userId, projectId, corp.organisationId, testDb),
    ).rejects.toBeInstanceOf(NotFoundError);
  });
});
```

- [ ] **Step 7: Run it to verify it fails**

Run: `DATABASE_URL=... TEST_DATABASE_URL=... npm run test:integration -- src/modules/commitments/resource-gifts.integration.test.ts` (both URLs as in Global Constraints)
Expected: FAIL — `listResourceGiftsForCorp` is not defined.

- [ ] **Step 8: Implement `listResourceGiftsForCorp`** in `src/modules/commitments/gifts.ts` (add after `listResourceGiftsForProject`). `and`, `eq`, `resourceGifts`, and `assertCorpManager` are already imported in this file.

```typescript
/** US-5.5 — the offering corp views its own gifts on a project. */
export async function listResourceGiftsForCorp(
  actingUserId: string,
  projectId: string,
  corporationOrgId: string,
  db: Db = defaultDb,
) {
  await assertCorpManager(db, actingUserId, corporationOrgId);
  return db.query.resourceGifts.findMany({
    where: and(
      eq(resourceGifts.projectId, projectId),
      eq(resourceGifts.corporationOrgId, corporationOrgId),
    ),
  });
}
```

- [ ] **Step 9: Export it** — add `listResourceGiftsForCorp` to the `./gifts` export block in `src/modules/commitments/index.ts`.

- [ ] **Step 10: Run both tests + typecheck + lint**

Run: `DATABASE_URL=... TEST_DATABASE_URL=... npm run test:integration -- src/modules/identity/get-user-org.integration.test.ts src/modules/commitments/resource-gifts.integration.test.ts`
Expected: PASS.
Run: `npm run typecheck && npm run lint`
Expected: PASS.

- [ ] **Step 11: Commit**

```bash
git add src/modules/identity/ src/modules/commitments/
git commit -m "feat(reads): getUserOrg + listResourceGiftsForCorp for gift UI"
```

---

### Task 2: Role-aware page + read-only needs panel + digital-needs editor

**Files:**
- Modify: `src/app/projects/[id]/page.tsx` (role resolution + read-only digital-needs panel + charity-owner editor mount point)
- Create: `src/app/projects/[id]/DigitalNeedsEditor.tsx`
- Modify: `src/app/globals.css` (needs-panel + editor styles)

**Interfaces:**
- Consumes: `getPublishedProject` (already imported; returns `{ ...project, resourceNeeds, digitalResourceNeeds }` incl. `charityOrgId`, `status`); `getSession` (`@/lib/auth`); `findMembership` (`@/modules/identity`); `DIGITAL_RESOURCE_KINDS` (`@/modules/projects`).
- Produces: server-resolved `isCharityOwner: boolean` on the page; the `DigitalNeedsEditor` client component; a humaniser for gift kinds reused by later tasks (define `KIND_LABEL` in the page).

- [ ] **Step 1: Add the digital-needs editor client component** — create `src/app/projects/[id]/DigitalNeedsEditor.tsx`:

```typescript
'use client';

import { useState } from 'react';

const KINDS = [
  'cloud_credits',
  'api_budget',
  'llm_budget',
  'saas_seats',
  'hosting',
  'domains',
  'other',
] as const;
type Kind = (typeof KINDS)[number];
const LABEL: Record<Kind, string> = {
  cloud_credits: 'Cloud credits',
  api_budget: 'API budget',
  llm_budget: 'LLM budget',
  saas_seats: 'SaaS seats',
  hosting: 'Hosting',
  domains: 'Domains',
  other: 'Other',
};

interface Row {
  kind: Kind;
  description: string;
  quantity: string;
  unit: string;
}
type InitialNeed = { kind: string; description?: string | null; quantity?: number | null; unit?: string | null };

export default function DigitalNeedsEditor({
  projectId,
  initialNeeds,
}: {
  projectId: string;
  initialNeeds: InitialNeed[];
}) {
  const [rows, setRows] = useState<Row[]>(
    initialNeeds.map((n) => ({
      kind: (KINDS as readonly string[]).includes(n.kind) ? (n.kind as Kind) : 'other',
      description: n.description ?? '',
      quantity: n.quantity != null ? String(n.quantity) : '',
      unit: n.unit ?? '',
    })),
  );
  const [state, setState] = useState<'idle' | 'busy'>('idle');
  const [msg, setMsg] = useState('');

  function update(i: number, patch: Partial<Row>) {
    setRows((rs) => rs.map((r, idx) => (idx === i ? { ...r, ...patch } : r)));
  }
  function addRow() {
    setRows((rs) => [...rs, { kind: 'cloud_credits', description: '', quantity: '', unit: '' }]);
  }
  function removeRow(i: number) {
    setRows((rs) => rs.filter((_, idx) => idx !== i));
  }

  async function save() {
    setState('busy');
    setMsg('');
    const needs = rows.map((r) => ({
      kind: r.kind,
      ...(r.description.trim() ? { description: r.description.trim() } : {}),
      ...(r.quantity.trim() ? { quantity: Number(r.quantity) } : {}),
      ...(r.unit.trim() ? { unit: r.unit.trim() } : {}),
    }));
    try {
      const res = await fetch(`/api/projects/${projectId}/digital-resource-needs`, {
        method: 'PUT',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ needs }),
      });
      if (res.status === 401) {
        setMsg('Sign in to edit this project.');
        setState('idle');
        return;
      }
      if (!res.ok) throw new Error();
      window.location.reload();
    } catch {
      setMsg('Could not save. Please try again.');
      setState('idle');
    }
  }

  return (
    <div className="gift-editor">
      {rows.length === 0 && <p className="about">No digital resources requested yet.</p>}
      {rows.map((r, i) => (
        <div className="gift-editor-row" key={i}>
          <select value={r.kind} onChange={(e) => update(i, { kind: e.target.value as Kind })}>
            {KINDS.map((k) => (
              <option key={k} value={k}>
                {LABEL[k]}
              </option>
            ))}
          </select>
          <input
            placeholder="quantity"
            inputMode="numeric"
            value={r.quantity}
            onChange={(e) => update(i, { quantity: e.target.value })}
          />
          <input placeholder="unit (e.g. seats)" value={r.unit} onChange={(e) => update(i, { unit: e.target.value })} />
          <input
            placeholder="description"
            value={r.description}
            onChange={(e) => update(i, { description: e.target.value })}
          />
          <button type="button" className="gift-x" onClick={() => removeRow(i)} aria-label="Remove">
            ×
          </button>
        </div>
      ))}
      <div className="gift-editor-actions">
        <button type="button" className="btn-ghost" onClick={addRow}>
          + Add resource
        </button>
        <button type="button" className="btn" onClick={save} disabled={state === 'busy'}>
          {state === 'busy' ? 'Saving…' : 'Save resources needed'}
        </button>
      </div>
      {msg && <p className="support-note">{msg}</p>}
    </div>
  );
}
```

- [ ] **Step 2: Make the page role-aware and render the panels.** Edit `src/app/projects/[id]/page.tsx`. Add imports at the top:

```typescript
import { getSession } from '@/lib/auth';
import { findMembership } from '@/modules/identity';
import DigitalNeedsEditor from './DigitalNeedsEditor';
```

Add a shared kind humaniser above the component (used here and in later tasks):

```typescript
const KIND_LABEL: Record<string, string> = {
  cloud_credits: 'Cloud credits',
  api_budget: 'API budget',
  llm_budget: 'LLM budget',
  saas_seats: 'SaaS seats',
  hosting: 'Hosting',
  domains: 'Domains',
  other: 'Other',
};
```

Inside `ProjectPage`, after `if (!project) notFound();` and the existing `Promise.all`, resolve the viewer:

```typescript
  const session = await getSession();
  const membership = session ? await findMembership(session.userId, project.charityOrgId) : null;
  const isCharityOwner = membership?.role === 'charity_owner';
```

Then, in the left column (after the existing "Help needed" panel `</div>` that closes it, i.e. after line ~93 `</div>`), add the read-only digital-resources panel for everyone plus the owner editor:

```tsx
            <div className="panel" style={{ marginTop: 20 }}>
              <h3>Digital resources needed</h3>
              {project.digitalResourceNeeds.length === 0 ? (
                <p className="about">No digital resources requested yet.</p>
              ) : (
                project.digitalResourceNeeds.map((n) => (
                  <div className="need" key={n.id}>
                    <div className="role">
                      {n.quantity ? `${n.quantity} ` : ''}
                      {n.unit ? `${n.unit} · ` : ''}
                      {KIND_LABEL[n.kind] ?? n.kind}
                    </div>
                    {n.description && <div className="detail-line">{n.description}</div>}
                  </div>
                ))
              )}
              {isCharityOwner && (
                <div style={{ marginTop: 16 }}>
                  <h3 style={{ marginTop: 0 }}>Edit digital resources needed</h3>
                  <DigitalNeedsEditor projectId={id} initialNeeds={project.digitalResourceNeeds} />
                </div>
              )}
            </div>
```

- [ ] **Step 3: Add styles** to `src/app/globals.css` (append near the end, before the responsive media queries):

```css
/* ── Resource gifts ───────────────────────────────────────── */
.btn-ghost {
  border: 1px solid var(--line);
  background: transparent;
  color: var(--ink);
  border-radius: var(--radius);
  padding: 8px 14px;
  font: inherit;
  font-size: 0.85rem;
  cursor: pointer;
}
.btn-ghost:hover {
  border-color: var(--teal);
}
.gift-editor {
  display: flex;
  flex-direction: column;
  gap: 10px;
}
.gift-editor-row {
  display: grid;
  grid-template-columns: 1.2fr 0.7fr 0.9fr 1.6fr auto;
  gap: 8px;
  align-items: center;
}
.gift-editor-row select,
.gift-editor-row input {
  border: 1px solid var(--line);
  border-radius: var(--radius);
  background: var(--card);
  padding: 8px 10px;
  font: inherit;
  font-size: 0.85rem;
  color: var(--ink);
  min-width: 0;
}
.gift-x {
  border: 0;
  background: transparent;
  color: var(--muted);
  font-size: 1.1rem;
  cursor: pointer;
}
.gift-x:hover {
  color: var(--signal);
}
.gift-editor-actions {
  display: flex;
  gap: 10px;
  justify-content: flex-end;
}
```

- [ ] **Step 4: Verify**

Run: `npm run typecheck && npm run lint && npm run build`
Expected: PASS; build lists `/projects/[id]` as a dynamic route.

- [ ] **Step 5: Commit**

```bash
git add "src/app/projects/[id]/page.tsx" "src/app/projects/[id]/DigitalNeedsEditor.tsx" src/app/globals.css
git commit -m "feat(ui): role-aware project page + digital-needs panel & editor"
```

---

### Task 3: Charity gift-offers panel + `GiftActions` component

**Files:**
- Create: `src/app/projects/[id]/GiftActions.tsx`
- Modify: `src/app/projects/[id]/page.tsx` (fetch + render the charity "Gift offers" panel)
- Modify: `src/app/globals.css` (gift row + status chip styles)

**Interfaces:**
- Consumes: `isCharityOwner` + `KIND_LABEL` (Task 2); `listResourceGiftsForProject` (`@/modules/commitments`); gift rows have `{ id, kind, quantity, unit, note, status, needId, corporationOrgId, reason, providedAt, receivedAt }`.
- Produces: `GiftActions({ giftId, status, perspective })` client component (`perspective: 'charity' | 'corp'`), reused by Task 4.

- [ ] **Step 1: Build the `GiftActions` client component** — create `src/app/projects/[id]/GiftActions.tsx`. It shows the buttons valid for the gift's `status` and the viewer's `perspective`, and collects a reason inline for decline/withdraw.

```typescript
'use client';

import { useState } from 'react';

type Perspective = 'charity' | 'corp';

async function post(path: string, body?: unknown): Promise<Response> {
  return fetch(path, {
    method: 'POST',
    headers: body ? { 'content-type': 'application/json' } : undefined,
    body: body ? JSON.stringify(body) : undefined,
  });
}

export default function GiftActions({
  giftId,
  status,
  perspective,
}: {
  giftId: string;
  status: string;
  perspective: Perspective;
}) {
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState('');
  const [reasonFor, setReasonFor] = useState<'decline' | 'withdraw' | null>(null);
  const [reason, setReason] = useState('');

  async function act(path: string, body?: unknown) {
    setBusy(true);
    setMsg('');
    try {
      const res = await post(`/api/resource-gifts/${giftId}/${path}`, body);
      if (res.status === 401) {
        setMsg('Sign in to continue.');
        setBusy(false);
        return;
      }
      if (!res.ok) throw new Error();
      window.location.reload();
    } catch {
      setMsg('Could not complete that. Please try again.');
      setBusy(false);
    }
  }

  if (reasonFor) {
    return (
      <div className="gift-reason">
        <input
          placeholder={`Reason to ${reasonFor}`}
          value={reason}
          onChange={(e) => setReason(e.target.value)}
        />
        <button
          className="btn"
          disabled={busy || !reason.trim()}
          onClick={() => act(reasonFor, { reason: reason.trim() })}
        >
          Confirm {reasonFor}
        </button>
        <button className="btn-ghost" onClick={() => setReasonFor(null)} disabled={busy}>
          Cancel
        </button>
      </div>
    );
  }

  const buttons: React.ReactNode[] = [];
  if (perspective === 'charity') {
    if (status === 'offered') {
      buttons.push(
        <button key="a" className="btn" disabled={busy} onClick={() => act('accept')}>
          Accept
        </button>,
        <button key="d" className="btn-ghost" disabled={busy} onClick={() => setReasonFor('decline')}>
          Decline
        </button>,
      );
    } else if (status === 'provided') {
      buttons.push(
        <button key="r" className="btn" disabled={busy} onClick={() => act('received')}>
          Confirm received
        </button>,
      );
    }
  } else {
    if (status === 'accepted') {
      buttons.push(
        <button key="p" className="btn" disabled={busy} onClick={() => act('provided')}>
          Mark provided
        </button>,
      );
    }
    if (status === 'offered' || status === 'accepted' || status === 'provided') {
      buttons.push(
        <button key="w" className="btn-ghost" disabled={busy} onClick={() => setReasonFor('withdraw')}>
          Withdraw
        </button>,
      );
    }
  }

  if (buttons.length === 0 && !msg) return null;
  return (
    <div className="gift-actions">
      {buttons}
      {msg && <span className="support-note">{msg}</span>}
    </div>
  );
}
```

- [ ] **Step 2: Render the charity "Gift offers" panel.** In `src/app/projects/[id]/page.tsx`, add the import:

```typescript
import { listResourceGiftsForProject } from '@/modules/commitments';
import GiftActions from './GiftActions';
```

After the `isCharityOwner` line, fetch the gifts when the viewer is the owner:

```typescript
  const charityGifts =
    isCharityOwner && session ? await listResourceGiftsForProject(session.userId, id) : [];
```

Add a `GIFT_STATUS_LABEL` map next to `KIND_LABEL`:

```typescript
const GIFT_STATUS_LABEL: Record<string, string> = {
  offered: 'Offered',
  accepted: 'Accepted',
  declined: 'Declined',
  provided: 'Provided',
  received: 'Received',
  withdrawn: 'Withdrawn',
};
```

In the left column, after the digital-resources panel, render the owner's gift-offers panel:

```tsx
            {isCharityOwner && (
              <div className="panel" style={{ marginTop: 20 }}>
                <h3>Gift offers</h3>
                {charityGifts.length === 0 ? (
                  <p className="about">No resource gifts have been offered yet.</p>
                ) : (
                  charityGifts.map((g) => (
                    <div className="gift-row" key={g.id}>
                      <div className="gift-main">
                        <div className="role">
                          {g.quantity ? `${g.quantity} ` : ''}
                          {g.unit ? `${g.unit} · ` : ''}
                          {KIND_LABEL[g.kind] ?? g.kind}
                        </div>
                        {g.note && <div className="detail-line">{g.note}</div>}
                        {g.reason && <div className="detail-line">Reason: {g.reason}</div>}
                      </div>
                      <span className={`gift-chip gift-chip-${g.status}`}>
                        {GIFT_STATUS_LABEL[g.status] ?? g.status}
                      </span>
                      <GiftActions giftId={g.id} status={g.status} perspective="charity" />
                    </div>
                  ))
                )}
              </div>
            )}
```

- [ ] **Step 3: Add gift-row + chip styles** to `src/app/globals.css` (append to the resource-gifts block from Task 2):

```css
.gift-row {
  display: grid;
  grid-template-columns: 1fr auto;
  gap: 6px 12px;
  align-items: start;
  padding: 12px 0;
  border-top: 1px solid var(--line);
}
.gift-row:first-of-type {
  border-top: 0;
}
.gift-main {
  grid-column: 1;
}
.gift-chip {
  grid-column: 2;
  justify-self: end;
  font-size: 0.7rem;
  letter-spacing: 0.1em;
  text-transform: uppercase;
  padding: 3px 8px;
  border-radius: 999px;
  border: 1px solid var(--line);
  color: var(--muted);
  white-space: nowrap;
}
.gift-chip-accepted,
.gift-chip-received {
  border-color: var(--teal);
  color: var(--teal);
}
.gift-chip-declined,
.gift-chip-withdrawn {
  color: var(--signal);
  border-color: var(--signal);
}
.gift-actions,
.gift-reason {
  grid-column: 1 / -1;
  display: flex;
  gap: 8px;
  align-items: center;
  flex-wrap: wrap;
  margin-top: 4px;
}
.gift-actions .btn,
.gift-reason .btn {
  padding: 7px 14px;
  font-size: 0.82rem;
}
.gift-reason input {
  border: 1px solid var(--line);
  border-radius: var(--radius);
  background: var(--card);
  padding: 8px 10px;
  font: inherit;
  font-size: 0.85rem;
  flex: 1;
  min-width: 160px;
}
```

- [ ] **Step 4: Verify**

Run: `npm run typecheck && npm run lint && npm run build`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add "src/app/projects/[id]/page.tsx" "src/app/projects/[id]/GiftActions.tsx" src/app/globals.css
git commit -m "feat(ui): charity gift-offers panel with accept/decline/confirm"
```

---

### Task 4: Corporation section — offer form + your-offers

**Files:**
- Create: `src/app/projects/[id]/OfferGiftForm.tsx`
- Modify: `src/app/projects/[id]/page.tsx` (resolve corp viewer + render offer form + your-offers, reusing `GiftActions`)
- Modify: `src/app/globals.css` (reuse existing styles; add only if needed)

**Interfaces:**
- Consumes: `getUserOrg` (`@/modules/identity`), `listResourceGiftsForCorp` (`@/modules/commitments`) from Task 1; `GiftActions` (Task 3); `KIND_LABEL`/`GIFT_STATUS_LABEL` (Tasks 2–3); `project.digitalResourceNeeds`.
- Produces: `OfferGiftForm` client component.

- [ ] **Step 1: Build the offer form** — create `src/app/projects/[id]/OfferGiftForm.tsx`:

```typescript
'use client';

import { useState } from 'react';

const KINDS = [
  'cloud_credits',
  'api_budget',
  'llm_budget',
  'saas_seats',
  'hosting',
  'domains',
  'other',
] as const;
type Kind = (typeof KINDS)[number];
const LABEL: Record<Kind, string> = {
  cloud_credits: 'Cloud credits',
  api_budget: 'API budget',
  llm_budget: 'LLM budget',
  saas_seats: 'SaaS seats',
  hosting: 'Hosting',
  domains: 'Domains',
  other: 'Other',
};

export default function OfferGiftForm({
  projectId,
  corporationOrgId,
  needs,
}: {
  projectId: string;
  corporationOrgId: string;
  needs: { id: string; kind: string; description?: string | null }[];
}) {
  const [kind, setKind] = useState<Kind>('cloud_credits');
  const [needId, setNeedId] = useState('');
  const [quantity, setQuantity] = useState('');
  const [unit, setUnit] = useState('');
  const [note, setNote] = useState('');
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState('');

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    setBusy(true);
    setMsg('');
    const body = {
      corporationOrgId,
      kind,
      ...(needId ? { needId } : {}),
      ...(quantity.trim() ? { quantity: Number(quantity) } : {}),
      ...(unit.trim() ? { unit: unit.trim() } : {}),
      ...(note.trim() ? { note: note.trim() } : {}),
    };
    try {
      const res = await fetch(`/api/projects/${projectId}/resource-gifts`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(body),
      });
      if (res.status === 401) {
        setMsg('Sign in to offer a gift.');
        setBusy(false);
        return;
      }
      if (!res.ok) {
        const data = (await res.json().catch(() => null)) as { message?: string } | null;
        setMsg(data?.message ?? 'Could not submit the offer. Please try again.');
        setBusy(false);
        return;
      }
      window.location.reload();
    } catch {
      setMsg('Could not reach HodorHub. Please try again.');
      setBusy(false);
    }
  }

  return (
    <form className="gift-editor" onSubmit={submit}>
      <div className="gift-editor-row" style={{ gridTemplateColumns: '1.2fr 0.7fr 0.9fr 1.6fr' }}>
        <select value={kind} onChange={(e) => setKind(e.target.value as Kind)}>
          {KINDS.map((k) => (
            <option key={k} value={k}>
              {LABEL[k]}
            </option>
          ))}
        </select>
        <input placeholder="quantity" inputMode="numeric" value={quantity} onChange={(e) => setQuantity(e.target.value)} />
        <input placeholder="unit (e.g. USD credits)" value={unit} onChange={(e) => setUnit(e.target.value)} />
        <input placeholder="note (optional)" value={note} onChange={(e) => setNote(e.target.value)} />
      </div>
      {needs.length > 0 && (
        <select value={needId} onChange={(e) => setNeedId(e.target.value)}>
          <option value="">Toward the project generally</option>
          {needs.map((n) => (
            <option key={n.id} value={n.id}>
              Toward: {LABEL[(KINDS as readonly string[]).includes(n.kind) ? (n.kind as Kind) : 'other']}
              {n.description ? ` — ${n.description}` : ''}
            </option>
          ))}
        </select>
      )}
      <div className="gift-editor-actions">
        <button type="submit" className="btn" disabled={busy}>
          {busy ? 'Offering…' : 'Offer resource gift'}
        </button>
      </div>
      {msg && <p className="support-note">{msg}</p>}
    </form>
  );
}
```

- [ ] **Step 2: Wire the corp section into the page.** In `src/app/projects/[id]/page.tsx`, add imports:

```typescript
import { getUserOrg } from '@/modules/identity';
import { listResourceGiftsForCorp } from '@/modules/commitments';
import OfferGiftForm from './OfferGiftForm';
```

After the charity resolution, resolve the corp viewer and their gifts:

```typescript
  const userOrg = session ? await getUserOrg(session.userId) : null;
  const isCorpManager =
    !!userOrg &&
    userOrg.role === 'csr_manager' &&
    userOrg.orgType === 'corporation' &&
    userOrg.status === 'verified';
  const corpGifts =
    isCorpManager && session
      ? await listResourceGiftsForCorp(session.userId, id, userOrg!.organisationId)
      : [];
```

In the `<aside>` column, after the existing support-card `</div>`, add the corp panel (only for a verified corp CSR manager, and only while the project accepts offers):

```tsx
            {isCorpManager && project.status === 'published' && (
              <div className="panel" style={{ marginTop: 20 }}>
                <h3>Offer a resource gift</h3>
                <OfferGiftForm
                  projectId={id}
                  corporationOrgId={userOrg!.organisationId}
                  needs={project.digitalResourceNeeds}
                />
                {corpGifts.length > 0 && (
                  <div style={{ marginTop: 16 }}>
                    <h3 style={{ marginTop: 0 }}>Your offers</h3>
                    {corpGifts.map((g) => (
                      <div className="gift-row" key={g.id}>
                        <div className="gift-main">
                          <div className="role">
                            {g.quantity ? `${g.quantity} ` : ''}
                            {g.unit ? `${g.unit} · ` : ''}
                            {KIND_LABEL[g.kind] ?? g.kind}
                          </div>
                          {g.reason && <div className="detail-line">Reason: {g.reason}</div>}
                        </div>
                        <span className={`gift-chip gift-chip-${g.status}`}>
                          {GIFT_STATUS_LABEL[g.status] ?? g.status}
                        </span>
                        <GiftActions giftId={g.id} status={g.status} perspective="corp" />
                      </div>
                    ))}
                  </div>
                )}
              </div>
            )}
```

- [ ] **Step 3: Verify (full gate — this is the last task)**

Set both DB URLs (see Global Constraints), then:
Run: `npm run typecheck && npm run lint && npm run build`
Expected: PASS.
Run: `npm run test:integration`
Expected: all files/tests pass (the Task 1 reads are covered; no page tests).

- [ ] **Step 4: Commit**

```bash
git add "src/app/projects/[id]/page.tsx" "src/app/projects/[id]/OfferGiftForm.tsx" src/app/globals.css
git commit -m "feat(ui): corp resource-gift offer form + your-offers panel"
```

---

## Self-Review

**Spec coverage:**
- §2 role model (session + `findMembership` for charity owner; `getUserOrg` gated on csr_manager/corporation/verified for corp) → Task 2 (owner) + Task 4 (corp) ✓
- §3 read-only digital-needs panel for everyone → Task 2 ✓
- §3 charity owner: needs editor → Task 2; gift offers accept/decline/confirm → Task 3 ✓
- §3 corp: offer form + your-offers mark-provided/withdraw → Task 4 ✓
- §4 backend reads (`getUserOrg`, `listResourceGiftsForCorp`) → Task 1 ✓
- §5 client components (`DigitalNeedsEditor`, `OfferGiftForm`, `GiftActions`) mirroring `SupportButton` → Tasks 2/3/4 ✓
- §6 styling reuse + `.gift-*` → Tasks 2/3 ✓
- §7 out of scope respected (no draft UI, no new routes, published-only) ✓
- §8 verification: backend reads tested (Task 1); typecheck/lint/build each UI task; **browser-driving each role happens at the whole-branch review** (controller — subagents can't screenshot). Flag this to the final review.

**Placeholder scan:** No TBD/TODO; every component and edit shows complete code; the two backend reads and their tests are fully written.

**Type consistency:** `KIND_LABEL`/`GIFT_STATUS_LABEL` defined once in `page.tsx` (Tasks 2–3) and reused. `GiftActions({ giftId, status, perspective })` is defined in Task 3 and reused in Task 4 with `perspective="corp"`. The `KINDS` tuple in the client components matches `DIGITAL_RESOURCE_KINDS`. `getUserOrg` return shape (`organisationId/role/orgType/status`) is consumed exactly in Task 4's `isCorpManager` check. Gift row fields (`id/kind/quantity/unit/note/status/needId/reason`) match the `resource_gifts` schema.

**Note for the executor:** the page is edited across Tasks 2–4; Read the current file before each edit. UI tasks are gated by typecheck/lint/build (no page-level tests exist in this repo, matching its conventions) — the role-visibility behavior is verified by the controller driving each role in the browser at the final review.
