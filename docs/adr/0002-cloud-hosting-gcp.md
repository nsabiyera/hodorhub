# ADR 0002 — Cloud hosting on GCP (funded phase)

- **Status:** Accepted
- **Date:** 2026-07-13
- **Author:** Architect
- **Supersedes:** the hosting/infra rows of [ADR 0001](./0001-zero-funding-stack.md) (compute, database, secrets/KMS, TLS, object storage, observability, backups). ADR 0001's *application* choices (TypeScript, Next.js, modular monolith + worker, Drizzle, pg-boss, in-house auth) are **retained**.
- **Context docs:** [`ARCHITECTURE.md`](../../ARCHITECTURE.md) §4, §11, §12

## Context

There is now a cloud hosting budget (**~$150–500/month, "comfortable" tier**). This removes the zero-funding constraint that forced a single self-hosted VM. The design goal shifts from *€0 cost* to *least operational burden for one developer per dollar*, while resolving the risks the DevOps review raised (no backups, env-var key, unmeasured SLOs). **The architecture in ARCHITECTURE.md §3/§6/§7/§8 does not change** — only its deployment realization.

## Decision

**Provider: Google Cloud Platform.** Chosen for solo-dev ergonomics: Cloud Run gives managed containers with scale-to-zero for the web tier and a trivially simple always-on worker service, built-in TLS, and clean custom-domain mapping — which directly serves the hybrid multi-tenant/branding requirement (§3, US-10.13) with far less bespoke work than self-managed Caddy. Cloud SQL, Secret Manager/KMS, GCS, and Memorystore complete a coherent managed set. (AWS App Runner + RDS or Azure Container Apps would also work; GCP wins on custom-domain ergonomics for a SaaS marketplace.)

| Concern | ADR 0001 (zero-funding) | ADR 0002 (GCP, comfortable) | Rationale |
|---------|-------------------------|-----------------------------|-----------|
| Compute — web | VM + Docker Compose | **Cloud Run** service, autoscale (min 1 warm) | No VM patching; zero-downtime; the *same* image (`Dockerfile`) runs unchanged. |
| Compute — worker | VM process | **Cloud Run** service, `min-instances=1`, no ingress | pg-boss is always-on, so it can't scale to zero — a dedicated always-on service. |
| Migrations | one-shot compose service | **Cloud Run Job** running `dist/migrate.cjs` before rollout | Native one-shot primitive; gated in the deploy pipeline. |
| Database | self-hosted Postgres, **no backups** | **Cloud SQL for PostgreSQL**, private IP, automated backups + PITR | Resolves the biggest solo-dev risk. Regional HA is the upgrade to the $500+ tier. |
| Cache / rate-limit | in-process LRU | **Memorystore (Redis) Basic** | Enables autoscaling the web tier past one instance; the in-process rate-limiter becomes Redis-backed. Sessions stay cookie-based. |
| Queue | pg-boss | **pg-boss (retained)** | Works, now backed by managed Postgres, safe across multiple workers. Not worth swapping for PubSub. |
| Secrets / token key | AES key in env var | **Secret Manager** (config) + **Cloud KMS** (token-encryption key) | Realises the envelope-encryption upgrade path; `crypto.ts` resolves the key from KMS at boot. |
| TLS + domains | Caddy on VM | **Global External App Load Balancer** + serverless NEG + Google-managed certs; **Cloudflare for SaaS** (or per-domain managed certs) for Enterprise custom domains | Robust managed TLS incl. the multi-tenant custom-domain story. |
| Object storage | local disk | **GCS bucket** | Org/project media; removes the local-disk footgun. |
| Email | free-tier SMTP | provider behind the existing interface (e.g. SendGrid) | GCP has no native email; abstraction unchanged. |
| Registry / deploy auth | GHCR + SSH | **Artifact Registry** + **Workload Identity Federation** (keyless GitHub→GCP) | Cloud Run pulls from Artifact Registry; WIF removes long-lived service-account keys. |
| Observability / SLOs | `console.warn` | **Cloud Logging/Monitoring/Trace**; alerts on ingestion lag + score-recompute (§10) | The §10 SLOs become measurable and alertable. |
| Environments | one VM | **staging + prod** (smaller staging), same image promoted | Safe releases; fits the comfortable tier. |
| IaC | none | **Terraform** for GCP resources (recommended) | Reproducible infra; one dev can rebuild the estate. |

## Code changes required (small, seams already exist)

1. **`src/lib/crypto.ts`** — add a boot-time key resolver that fetches the data-encryption key from Cloud KMS/Secret Manager; keep the key-as-argument signature (already refactored for this).
2. **Rate limiter** — implement the Redis-backed limiter behind the existing abstraction; select in-process vs Redis by env.
3. **DB connectivity** — connect to Cloud SQL over private IP via the Serverless VPC connector (or the Cloud SQL connector); `DATABASE_URL` from Secret Manager.
4. **Deploy pipeline** — push to Artifact Registry via WIF; `gcloud run deploy` web + worker; run the migration Cloud Run Job first. CI/CodeQL/Dependabot unchanged.

The Docker Compose + Caddy stack from ADR 0001 is **retained as a local prod-like harness and portability escape hatch**, not the production target.

## Cost sketch (order-of-magnitude, comfortable tier)

Cloud Run web+worker (~$30–80) · Cloud SQL small dedicated + backups (~$50–120) · Memorystore Basic (~$35) · Secret Manager/KMS/GCS/logging (~$10–30) · staging (~$30–60). ≈ **$150–350/mo**, within budget, with HA and heavier autoscaling as the headroom to the $500+ tier.

## Consequences

- **Positive:** automated backups/PITR, managed TLS + custom domains, KMS-held keys, measurable SLOs, keyless CI deploys, staging — most ADR 0001 deferrals closed.
- **Negative:** GCP coupling (mitigated: portable container + retained self-host stack); a new networking surface (VPC connector, private IP); recurring spend to monitor.

## Deploy-time settings (hardening)

- **Worker: CPU always allocated.** Cloud Run throttles CPU to ~0 between requests; the worker has no ingress, so without this its pg-boss poll loop, hourly cron, and the outbox relay would stall (TECH_DEBT A3). Note the billing change.
- **DB connection budget.** The app pool is bounded per instance via `DB_POOL_MAX` (default 5). Size Cloud SQL `max_connections` — or add a transaction-mode pooler — against `max × maxInstances + worker + migrate` (TECH_DEBT A2).

## Follow-ups

- Decide **regional HA** for Cloud SQL now vs at the $500+ tier (currently: backups yes, HA later — `db_ha` toggle).
- ~~Stand up Terraform + WIF before the first cloud deploy~~ → **done:** `infra/terraform/` (validated) + WIF-based `.github/workflows/deploy.yml`. Not yet `apply`d against a live project.
- Confirm the email provider and the Cloudflare-for-SaaS vs managed-certs choice when Enterprise custom domains (Release 2) are built.
- **Memorystore** intentionally not provisioned yet (app has no Redis dependency); add with a Serverless VPC connector when the Redis-backed limiter / horizontal scale lands.
