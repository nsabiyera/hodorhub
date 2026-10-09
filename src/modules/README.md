# Bounded contexts (`src/modules/*`)

Each subfolder is one bounded context from [`ARCHITECTURE.md`](../../ARCHITECTURE.md) §6. Rules:

- A module owns its tables (see `src/db/schema.ts`) and exposes a **service interface**.
- **No cross-module table access.** Talk to another context via its service or via a
  domain event on the outbox (`src/db/schema.ts` → `outbox`).
- The **support score** is owned by `scoring` and written only by the worker; other
  modules read `project_scores`, never recompute.
- **Integrity guardrail:** `scoring` and `discovery` must be payment- and brand-blind.
  `billing` gates features via `hasEntitlement(org, feature)`; it must never be an input
  to scoring or ranking.
- **Resource gifts are merit-blind (US-RG).** `resource_gifts` is a Commitments
  table. `scoring`/`engagement` and `discovery` must never read it or import from
  Commitments; a gift (offered/accepted/provided/received) is never an input to
  `project_scores` or to any discovery ORDER BY/filter, and never places donor
  branding on the neutral marketplace. Enforced by `scoring-boundary.test.ts` and
  `engagement/resource-gift-integrity.integration.test.ts`.

Planned modules: `identity`, `projects`, `engagement`, `scoring`, `discovery`,
`commitments`, `delivery`, `notifications`, `billing`, `admin`.
