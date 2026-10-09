# HodorHub

Social corporate-responsibility platform: **charities post projects → the public amplifies them on social media → corporations deliver them with donated employee time.** Public support (real Facebook/X engagement) drives a merit ranking that corporations discover through; corporations pledge and their employees deliver approved donated hours.

## Documentation

| Doc | What it covers |
|-----|----------------|
| [`PRODUCT_BACKLOG.md`](./PRODUCT_BACKLOG.md) | Personas, epics, user stories, release plan, decisions |
| [`ARCHITECTURE.md`](./ARCHITECTURE.md) | System design, bounded contexts, data model, flows, multi-tenancy |
| [`SUPPORT_SCORE_MODEL.md`](./SUPPORT_SCORE_MODEL.md) | How real social engagement becomes a gaming-resistant score |
| [`MONETISATION_MODEL.md`](./MONETISATION_MODEL.md) | Corporate freemium model; charities & supporters always free |
| [`docs/adr/0001-zero-funding-stack.md`](./docs/adr/0001-zero-funding-stack.md) | Why the concrete stack is what it is (solo dev, no funding) |
| [`docs/adr/0002-cloud-hosting-gcp.md`](./docs/adr/0002-cloud-hosting-gcp.md) | Cloud hosting on GCP now a budget exists (supersedes 0001's infra) |
| [`CONTRIBUTING.md`](./CONTRIBUTING.md) | Git workflow, local setup |
| [`SECURITY.md`](./SECURITY.md) | Security baseline & reporting |

## Stack (zero-funding realization — see ADR 0001)

TypeScript · **Next.js** (App Router, SSR) · **PostgreSQL** + **Drizzle** · **pg-boss** (Postgres job queue) · in-house **argon2** auth · **GitHub Actions** CI/CD + CodeQL + Dependabot. One app + one worker; single Docker image. **Hosted on GCP** — Cloud Run (web + worker), Cloud SQL, Memorystore, Secret Manager/KMS, GCS (see ADR 0002); the Docker Compose + Caddy stack remains a local/self-host fallback.

## Quick start

```bash
docker compose up -d                 # Postgres + MailHog (dev email UI at :8025)
cp .env.example .env.local           # fill APP_ENCRYPTION_KEY + SESSION_SECRET (see CONTRIBUTING.md)
npm install
npm run db:generate && npm run db:migrate
npm run dev                          # http://localhost:3000  (health: /api/health)
npm run worker                       # background worker, separate terminal
```

## Layout

```
src/
  app/            Next.js routes (SSR pages + API route handlers)
  config/         fail-fast env validation
  db/             Drizzle schema + client (full data model)
  lib/            crypto, password, tenant resolution (+ tests)
  modules/        bounded contexts (identity, projects, engagement, scoring, ...)
  worker/         pg-boss background worker (ingestion → scoring → notifications)
.github/          CI, CodeQL, Dependabot, deploy, PR template
docs/adr/         architecture decision records
```

## Non-negotiable invariants

- Charities & supporters never pay; corporations fund the platform.
- **Merit is never for sale** — scoring/ranking/discovery are payment- and brand-blind.
- The neutral public marketplace is never white-labelled.
- Donated hours count only once employer-approved.
