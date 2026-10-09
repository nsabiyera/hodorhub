# ADR 0001 — Zero-funding realization of the architecture

- **Status:** Accepted — **hosting/infra rows superseded by [ADR 0002](./0002-cloud-hosting-gcp.md)** (a cloud budget now exists). The application choices (TypeScript, Next.js, modular monolith + worker, Drizzle, pg-boss, in-house auth) remain in force.
- **Date:** 2026-07-13
- **Author:** Architect
- **Context docs:** [`ARCHITECTURE.md`](../../ARCHITECTURE.md) (§4 stack, §11 deployment, §12 open decisions 1–3)

## Context

HodorHub is being bootstrapped by **one developer with no funding**. `ARCHITECTURE.md` describes the target design in a cloud-managed form (AWS/GCP, Redis, KMS, provider auth). That target is sound but not affordable or operable by a solo founder. This ADR pins the **cost-optimized realization** of the *same* architecture: the bounded contexts, event bus, materialised score, and integrity guardrails are unchanged — only the concrete technology is chosen for €0 cost, minimal operational surface, and security.

## Decision

**Constraint rules:** no paid products; free/open-source or genuinely free tiers only (no card required where possible); one deployable + one worker; security not sacrificed for cost.

| Concern | Target (ARCHITECTURE.md) | MVP realization | Why |
|---------|--------------------------|-----------------|-----|
| Language | TypeScript | **TypeScript everywhere** | One dev → one language; shared domain code between web and worker. |
| Web + API | Next.js web + NestJS API (two services) | **Single Next.js app** (App Router; route handlers + server components) with internal `src/modules/*` bounded contexts | Fewer deployables to run/pay for; SSR still satisfies OG/Twitter cards. Module seams preserved so it can split later. |
| Background work | Separate worker fleet | **One worker process**, same codebase, different entrypoint (`src/worker`) | Matches "same code, different entrypoint"; ingestion/scoring/notifications run as queues within it. |
| Queue | Redis + BullMQ | **pg-boss** (Postgres-backed queue) | Removes a whole data store. Postgres is already required; pg-boss is MIT-licensed. |
| Cache / rate-limit | Redis | **In-process LRU + Postgres** | Single instance at MVP; scores are already materialised in Postgres. Re-introduce Redis when we scale horizontally. |
| Database | Managed RDS/Cloud SQL | **PostgreSQL** — Docker locally; a free-tier managed Postgres (e.g. Neon/Supabase free tier, no card) or self-hosted in prod | Free, portable, relational integrity + JSONB + window functions for scoring. |
| ORM / migrations | — | **Drizzle ORM + drizzle-kit** | SQL-first (scoring needs custom aggregates), lightweight, TypeScript, free. |
| Auth | Provider (Cognito/Auth0) | **In-house session auth** — argon2id, secure httpOnly cookies, CSRF tokens | Providers cost money at scale; in-house is free and, done carefully, secure. (Resolves §12 #2.) |
| Secrets / token encryption | KMS envelope encryption | **AES-256-GCM** with a key from env/CI secrets; documented upgrade path to KMS | No KMS bill; OAuth tokens still encrypted at rest. |
| TLS + custom domains | ACM / managed certs | **Caddy** reverse proxy — automatic Let's Encrypt, incl. on-demand TLS for tenant custom domains | Free automatic HTTPS; directly serves the multi-tenant branding requirement (US-10.13). |
| Object storage | S3 | **Local volume** at MVP; swap for a free-tier S3-compatible bucket later | Media is minimal until Release 3. |
| Email | SES/SendGrid | **SMTP behind an interface**; MailHog in dev; a free-tier sender (e.g. Brevo) in prod | Abstracted so the provider is swappable and dev needs no account. |
| Hosting | ECS/Fargate | **Docker Compose on a single small VM** (free-eligible: Oracle Cloud Always Free, or the founder's box for demo) | Cheapest operable footprint; portable image via GHCR. |
| CI/CD | — | **GitHub Actions** (lint/typecheck/test/build; CodeQL; Dependabot) → GHCR image → SSH deploy | Free for this scale; SAST + dependency scanning included free. |
| VCS workflow | — | **GitHub Flow** — protected `main`, feature branches, PR + green CI to merge | Simple, safe, solo-friendly. |

## What does NOT change

The **architecture** is intact: bounded contexts (§6), transactional-outbox event bus (§8), Scoring-owned materialised `project_scores` (§7), hybrid multi-tenancy with row-level `organisation_id` isolation (§3), and the merit-integrity guardrails (payment/brand never influence scoring or ranking). This ADR only chooses cheaper, self-hostable implementations of each seam.

## Consequences

- **Positive:** €0 running cost, one image to deploy, no vendor lock-in, security baseline (argon2, encrypted tokens, CSP, SAST, Dependabot) from day one.
- **Negative / deferred:** single-instance (no horizontal scale until Redis + external sessions return); self-managed backups/patching; free-tier limits on email/DB. All acceptable at MVP volume and explicitly revisited before scale.

## Follow-ups

- Re-introduce Redis + externalize sessions when a second app instance is needed.
- Move token encryption to a managed KMS once there is budget.
- Confirm final free-tier managed Postgres vs self-hosted before first production deploy.
