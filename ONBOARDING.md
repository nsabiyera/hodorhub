# HodorHub — Developer Onboarding

Welcome! This guide gets you from a fresh clone to shipping your first feature confidently. It assumes you can read TypeScript but knows nothing about this codebase.

Read this once end-to-end, then keep it open for your first week. When it disagrees with the code, the code wins — tell us so we can fix the guide.

---

## 1. What HodorHub is (the 2-minute version)

HodorHub connects **charities** with **corporations**. A charity posts a project and promotes it; the **public backs it** (support). Corporations discover the most-backed projects and deliver them by donating **employees' skilled time** — or, in the newest capability (Epic 11), by funding an **AI agent team** to build the software.

The whole product rests on a few **invariants**. Internalize these — most of our design decisions and review comments trace back to them:

1. **Merit is never for sale.** Support score, discovery ranking, and the marketplace are **payment- and brand-blind**. Nothing a corporation pays for (subscriptions, resource gifts, funded compute) may move a project up the rankings. This is enforced *structurally* and guarded by a test (`src/modules/scoring-boundary.test.ts`) — if you touch scoring/discovery, expect that test to have opinions.
2. **Charities & supporters never pay.** Corporations fund the platform.
3. **Human-in-the-loop for delivery.** Donated hours only count once an employer approves them; agent-built work only "delivers" once the charity approves it at each milestone gate.
4. **Tenant isolation.** One organisation must never see or affect another's data.
5. **Honest state.** Pending ≠ approved; provided ≠ received; a promise is never shown as a delivered fact.

The living docs are the source of truth for *what* and *why*:

| Doc | What's in it |
|-----|--------------|
| [`PRODUCT_BACKLOG.md`](./PRODUCT_BACKLOG.md) | Personas, epics, user stories (US-x.y) with acceptance criteria, release plan, resolved decisions |
| [`ARCHITECTURE.md`](./ARCHITECTURE.md) | System design, bounded contexts, data model, eventing, multi-tenancy, deployment |
| [`SUPPORT_SCORE_MODEL.md`](./SUPPORT_SCORE_MODEL.md) | How real social engagement becomes a gaming-resistant score |
| [`MONETISATION_MODEL.md`](./MONETISATION_MODEL.md) | Corporate freemium model |
| [`docs/adr/`](./docs/adr/) | Architecture Decision Records — *why* the stack/hosting/isolation are what they are |
| [`CONTRIBUTING.md`](./CONTRIBUTING.md) | Git workflow, branch naming, commit messages, local setup |

When you pick up a ticket, start from its **US-x.y** in the backlog — the acceptance criteria are your definition of done.

---

## 2. The stack (and why)

- **TypeScript**, **Next.js 15 App Router** (React 19) — one app serves both the web UI and the JSON API (route handlers under `src/app/api`).
- **Drizzle ORM** + **PostgreSQL** — typed schema in `src/db/schema.ts`, migrations in `drizzle/`.
- **pg-boss** — a Postgres-backed job queue (no Redis at MVP). Powers the background **worker** (`src/worker/index.ts`): the transactional-outbox relay, and the agent-delivery run dispatcher.
- **Auth** is in-house: argon2id password hashing + signed, httpOnly session cookies (`src/lib/session.ts`, `src/lib/auth.ts`). No third-party auth provider.
- **zod** for input validation everywhere at the boundary.
- **Vitest** for tests. **ESLint + Prettier** for style. **tsc** for types.

Rationale lives in [ADR 0001](./docs/adr/0001-zero-funding-stack.md) (stack) and [ADR 0002](./docs/adr/0002-cloud-hosting-gcp.md) (GCP hosting). Don't swap a load-bearing choice without an ADR.

---

## 3. Get it running locally

Full setup is in [`CONTRIBUTING.md`](./CONTRIBUTING.md#local-setup); here's the fast path plus the bits that trip people up.

```bash
docker compose up -d                 # Postgres + MailHog (dev mail catcher on :8025)
cp .env.example .env.local           # then fill APP_ENCRYPTION_KEY + SESSION_SECRET (see CONTRIBUTING)
npm install
npm run db:migrate                   # apply migrations to your dev DB
npm run db:seed                      # create known test accounts (see below)
npm run dev                          # web app on http://localhost:3000
```

For anything that uses the background worker (notifications, agent-delivery runs), run it in a **second terminal**:

```bash
npm run worker                       # tsx watch src/worker/index.ts
```

**Seed test accounts** (`npm run db:seed`, idempotent) — sign in at `/signin`:

| Email | Password | Role |
|-------|----------|------|
| `admin@hodorhub.test` | `Password123!` | Platform admin |
| `charity@hodorhub.test` | `Password123!` | Charity owner (org "Helping Hands", verified) |
| `corp@hodorhub.test` | `Password123!` | CSR manager (org "Globex", verified) |

**Gotchas:**
- `.env.local` is not auto-loaded by standalone scripts — `db:seed` and the worker load it via `--env-file`; `drizzle-kit` reads `DATABASE_URL` from the environment (set it inline if a `db:*` command complains).
- The **integration test DB is separate** (`hodorhub_test`) — see §6.
- The worker needs Postgres up; it won't advance agent-delivery runs if it isn't running.

---

## 4. Codebase map

```
src/
  app/                       Next.js App Router
    api/**/route.ts          JSON API endpoints (thin — they call services)
    projects/[id]/page.tsx   server components + colocated 'use client' islands
    _components/             shared form components
  modules/                   the bounded contexts — THE business logic lives here
    identity/                users, orgs, memberships, roles, sessions, verification
    projects/                projects, resource needs, lifecycle state machine
    engagement/              on-platform support + ingested social engagement
    scoring/                 trust/anti-gaming + support & momentum score (merit)
    discovery/               read model: browse/rank projects by support
    commitments/             interest, pledges, resource gifts, compute pledges
    delivery/                volunteer allocations, hour logs + approval
    agent-delivery/          Epic 11: agent runs, budget ledger, phase gates
    notifications/           notification records + the outbox relay
    moderation/ privacy/     admin actions, GDPR erase/retention
  lib/                       cross-cutting: auth, session, crypto, http, ratelimit, mailer,
                             model-provider (+ fakes), sandbox-runner, deployer
  db/                        schema.ts (all tables), index.ts (the db client), migrate.ts
  worker/                    the background process entrypoint
  test/                      integration-test harness (db reset, global setup)
```

**Mental model — a modular monolith.** Each module in `src/modules/*` is a **bounded context**: it owns its tables and exposes a public interface via its `index.ts`. **Modules never import another module's internals or reach into its tables** — they call the other module's exported service functions or react to its domain events. When you need something from another context, import from `@/modules/<name>` (the barrel), never a deep path.

**Modules talk via a transactional outbox.** A service writes its state change *and* an `outbox` row in the same DB transaction; the worker's relay publishes those rows to subscribers (Notifications today). This is why there's no "call the notifications service inline" — you emit an event.

---

## 5. The house style (learn these — reviews enforce them)

These conventions are consistent across every module. Copy the nearest existing example; don't invent a new shape.

**Service functions** (the unit of business logic, in `src/modules/<ctx>/service.ts`):
- Signature: `actingUserId` first, an injectable executor **`db` last** (`db: Db = defaultDb`). Internal tx-helpers take the executor **first** (like `beginDelivery(tx, …)`).
- They **do their own authorization**: load the target, resolve the owning `organisation_id`, check membership + role. **Cross-tenant access returns `NotFoundError`** (never leak that the thing exists); **wrong role returns `ForbiddenError`**; a bad state transition throws `InvalidStateError`. Use the error classes from `@/modules/identity`.
- Anything that others react to writes an `outbox` row **in the same transaction** as the state change.
- Money is **integer minor units** (pence). Never floats.

**API routes** (`src/app/api/**/route.ts`) are thin:
```ts
export async function POST(req: Request, { params }: { params: Promise<{ id: string }> }) {
  try {
    const session = await requireUser();          // 401 if not signed in
    const { id } = await params;
    const body = schema.parse(await readJson(req)); // zod; throws → 400
    const result = await someService(session.userId, id, body);
    return NextResponse.json({ ok: true, ...result });
  } catch (e) {
    return errorResponse(e);                        // maps DomainError → status; never leaks internals
  }
}
```
Routes **never** re-implement authz or map status codes by hand — `errorResponse` (`src/lib/http.ts`) does that from the thrown error's type. All the real checks live in the service.

**Client components** are small `'use client'` islands (see `src/app/projects/[id]/GiftActions.tsx`): `fetch` the API, handle 401 ("Sign in to continue."), reload on success. Pages are **server components** that fetch via service reads and pass data down.

**Naming/UI:** reuse the existing CSS classes and panel patterns; match the surrounding code's density and idiom.

---

## 6. Testing

Two suites, deliberately split:

- **Unit** (`*.test.ts`) — pure logic, no DB. Fast. `npm test`.
- **Integration** (`*.integration.test.ts`) — real Postgres. `npm run test:integration`. Needs the DB up and **both** `TEST_DATABASE_URL` and `DATABASE_URL` pointed at the test DB:
  ```bash
  TEST_DATABASE_URL=postgres://hodorhub:hodorhub@localhost:5432/hodorhub_test \
  DATABASE_URL=postgres://hodorhub:hodorhub@localhost:5432/hodorhub_test \
  npm run test:integration
  ```
  (Route "contract" tests use the default `db`, which is why `DATABASE_URL` must also point at the test DB — a classic first-week head-scratcher.) The harness truncates all tables between tests (`src/test/`), so tests are isolated; don't rely on ordering.

We practice **TDD**: write the failing test, watch it fail, implement, watch it pass. Integration tests are where the important behaviour is proven — especially the negative cases: unauthorised access, wrong role, **cross-tenant access**, invalid state transitions, and the **merit-integrity** invariant (a paid/gift/agent action must write **zero** score rows). If you add a mutating flow, add the negative tests too — a happy-path-only test will bounce in review.

**Before you push, the full gate must be green:**
```bash
npm run typecheck && npm run lint && npm test && npm run test:integration
# and if you touched the worker/build: npm run build && npm run build:workers
```

---

## 7. How to add functionality (a worked walkthrough)

We build in **thin vertical slices**, one bounded context at a time, each committed at a green checkpoint. Say you're implementing a new charity-facing action. The path, back to front:

1. **Start from the story.** Find/confirm the `US-x.y` in `PRODUCT_BACKLOG.md`; its acceptance criteria are your done. If it's genuinely new, add the story first.
2. **Data model** (if needed). Add/extend tables in `src/db/schema.ts` (follow the existing table style — enums, FKs, `organisation_id`/owner columns, `CHECK`/unique constraints for invariants). Generate the migration:
   ```bash
   npm run db:generate      # creates drizzle/NNNN_*.sql — commit it; never hand-edit
   npm run db:migrate       # apply locally
   ```
3. **Service + tests** in the owning module (`src/modules/<ctx>/service.ts`). Write the integration test first (mirror an existing one for the fixtures: register org → verify → create project → …). Implement the function following the house style (§5): authz, own transaction, outbox event, error taxonomy. Export it from the module's `index.ts`.
4. **API route** (`src/app/api/**/route.ts`) — a thin handler calling your service (§5). Add a contract test if it's a security-sensitive endpoint.
5. **UI** — a server component reads via a service read function; a small `'use client'` component POSTs to your route and reloads. Reuse existing panels/classes. Gate visibility by role, but remember the **server** is the real enforcement — the UI only hides buttons.
6. **Verify** — run the full gate (§6) and, for anything with a runtime surface, **drive it in the running app** (sign in with a seed account and click through / `curl` the endpoint). Tests catch a lot; driving it catches status-code and UX bugs tests miss.
7. **Commit** small and focused with a Conventional Commit message (`feat(commitments): …`), branch + PR per [`CONTRIBUTING.md`](./CONTRIBUTING.md).

**Golden rule for a first feature:** find the closest existing thing and mirror it. Resource gifts (`src/modules/commitments/gifts.ts` + `src/app/api/resource-gifts/**` + `src/app/projects/[id]/GiftActions.tsx`) are a complete, representative example of a slice — reads, mutations with a state machine, routes, and UI.

---

## 8. Things that will bite you (and how to avoid them)

- **Don't reach across modules.** Import from `@/modules/<name>` (the barrel), call the service, or emit an event. A deep import into another module's tables/files will fail review.
- **Don't touch scoring/discovery casually.** They must stay payment/brand/gift/agent-blind. `scoring-boundary.test.ts` will fail if you introduce a forbidden reference — that's the guardrail working, not a flaky test.
- **`NotFound` vs `Forbidden`.** Cross-tenant → `NotFoundError` (no existence leak). Same-org wrong-role → `ForbiddenError`. Getting this backwards is a security bug.
- **Outbox, not inline calls.** To notify or trigger downstream work, write an outbox event in your transaction; don't call Notifications directly.
- **Money is minor units.** Integers everywhere; only convert to `£` at the display edge.
- **Integration tests need both DB env vars** (§6).
- **The worker is a separate process.** If agent-delivery runs or notifications "don't do anything" locally, check the worker is running.

---

## 9. Getting help

- **Docs first:** the backlog for *what*, ARCHITECTURE + ADRs for *why*, this guide for *how*.
- **Pattern first:** the nearest existing slice is almost always the answer to "how do I structure this?".
- **Ask early.** A two-line question in the PR or to a senior beats a day of guessing — especially on anything touching auth, tenancy, or scoring.

Welcome aboard. Ship a small, well-tested slice in your first week and you'll have touched every layer that matters.
