# Security

Security is a first-class constraint for HodorHub (we store organisation credentials and social OAuth tokens). This documents the baseline built into the scaffold and how to report issues.

## Reporting a vulnerability

Please **do not** open a public issue. Email the maintainer (see repo owner) with details and a proof-of-concept if available. We aim to acknowledge within 72 hours.

## Baseline controls (in the scaffold)

| Area | Control |
|------|---------|
| Passwords | argon2id hashing (`src/lib/password.ts`) — never stored or logged in plaintext. |
| Secrets at rest | Social OAuth tokens encrypted with AES-256-GCM (`src/lib/crypto.ts`); key from `APP_ENCRYPTION_KEY`. |
| Config | Fail-fast env validation (`src/config/env.ts`); real secrets never committed (`.gitignore`, `.env.example`). |
| Transport | HTTPS everywhere via Caddy (Let's Encrypt); HSTS + security headers (`next.config.mjs`). |
| Sessions | Signed, `httpOnly`, `Secure`, `SameSite` cookies (in-house auth). CSRF tokens on state-changing requests. |
| Tenancy | Row-level `organisation_id` isolation; no cross-tenant data access. |
| Input | Validate all external input with zod at the boundary. |
| Abuse | Rate limiting on auth, support/like, and share endpoints; feeds the anti-gaming trust pipeline. |
| Supply chain | Dependabot updates + `npm audit` gate in CI; CodeQL SAST. |
| Containers | Non-root runtime user; minimal Alpine base; multi-stage build. |

## Known deferrals (see ADR 0001)

- Token-encryption key is env-sourced, not a managed KMS (upgrade when funded).
- Single-instance sessions; externalize before horizontal scaling.

These are acceptable at MVP volume and tracked for revisit before scale.
