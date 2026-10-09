# ADR 0003 — Agent-Delivered Projects: isolation, budget & delivery model (Epic 11)

- **Status:** Accepted (foundation slice); operational sandbox/hosting choices **Proposed** (pending devops)
- **Date:** 2026-07-15
- **Author:** Architect (with the agentic-systems researcher & engineer)
- **Builds on:** [ADR 0001](./0001-zero-funding-stack.md) (app stack), [ADR 0002](./0002-cloud-hosting-gcp.md) (GCP hosting). Adds a new bounded context; changes none of their decisions.
- **Context docs:** [`ARCHITECTURE.md`](../../ARCHITECTURE.md) §6, §7, §8, §11, §12.8–12.9; [`PRODUCT_BACKLOG.md`](../../PRODUCT_BACKLOG.md) Epic 11

## Context

Epic 11 (Agent-Delivered Projects) adds a path where, instead of donating human volunteer time, a corporation funds a **compute budget** and HodorHub delivers a charity's software project through a team of AI subagents, across human-approved milestones, ending in a **running, deployed app**.

This is qualitatively riskier than anything else on the platform: agent-generated code executes, spends real money, and (ultimately) deploys. The researcher's brief established that autonomous requirements→design→code→**deploy-to-prod** is not a proven, measurable reliability class, and that multi-agent systems fail most often on coordination/verification, not raw capability. The design must therefore make the dangerous parts impossible by construction, not merely discouraged.

Four HodorHub invariants bind every decision: human-in-the-loop, hard non-exceedable budget ceilings, **merit is never for sale** (agent activity must not touch the support score/ranking), and least privilege / auditability.

## Decision

### 1. A new bounded context, `Agent Delivery`, parallel to `Delivery`
Human donated-time delivery (`Delivery`: allocations, `hour_logs`) and agent delivery are **siblings**, not variants of one aggregate. Agent Delivery owns `agent_delivery_runs`, `run_budgets` + `run_budget_ledger`, `run_milestones`, and `agent_steps`. Agent-delivered work is reported **distinctly** from human hours and never unioned into an "hours" total (US-11.10).

### 2. Trigger: a `compute_pledges` sibling aggregate in Commitments (not a `resource_gift`, not a `pledge` flag)
A funded compute budget is **merit-blind like a resource gift** but, unlike one, HodorHub actively draws it down and escrows it — so it is its own Commitments aggregate, reusing the accept/decline pattern (US-5.3). On charity acceptance, Commitments moves the project to `in_delivery` and calls `AgentDelivery.createRunFromPledge` **synchronously in the same transaction** (a cross-module service call, mirroring `PledgeAccepted → create delivery workspace`), then emits `ComputePledgeAccepted`.

### 3. Budget: currency-canonical, tokens as audit, reserve-before-spend, DB-enforced ceiling
The ledger unit is **integer minor units (currency)**, with per-model token→currency rates pinned per run (tokens aren't fungible across model tiers, and the corporation commits cash, not tokens). Before every model step the orchestrator **reserves** the step's worst-case cost inside a transaction; if `remaining < estimate` the step does not start and the run halts. A DB `CHECK (consumed_minor + reserved_minor <= committed_minor)` on `run_budgets` is the backstop, so **overrun is impossible by construction** (US-11.4). Metering lives in Agent Delivery (co-located with runs for transactional halt-safety); real money movement is Billing's, Release 2.

### 4. Deterministic orchestrator + minimal agents behind a provider abstraction
The orchestrator is **plain code, never an LLM** — it owns the state machine, gates, budget accounting, and halt, and cannot be talked out of a halt. Models are reached only through a swappable `ModelProvider` interface (`src/lib/model-provider.ts`, mirroring `lib/mailer`) that reports per-call token usage. MVP uses 3 LLM roles (planner/worker/reviewer) with deterministic test execution as the primary acceptance oracle; a `FakeModelProvider` makes the whole pipeline testable offline.

### 5. Human milestone gates (never auto-deliver)
Each phase (requirements → design → build → delivery) pauses at `awaiting_review`; the **charity owner** approves / requests-changes / rejects — mirroring the employer-approved-hours state machine (US-6.2a). The funding **corporation is never a gate approver** (independence/merit conflict). Nothing advances or ships without a human approval (US-11.3).

### 6. Least privilege: sandbox + out-of-agent deployer + isolated hosting
- **Capability minimization over instruction policing.** No agent holds production credentials, arbitrary network egress, or the deployer.
- **microVM/gVisor sandboxes** (Firecracker/Kata/gVisor or a managed equivalent) for all code execution — **net-new infra; Cloud Run cannot host microVMs** (§11).
- **Delivered apps run outside HodorHub's own project/VPC** — a separate, egress-restricted "delivered-apps" GCP project with its own service accounts and **no** path to HodorHub's Cloud SQL/Memorystore/Secret Manager. The **charity owns** the delivered app and its data, with an export/handover path.
- **Deploy is a privileged Deployer** (a Cloud Run Job holding deploy creds) that no agent can invoke; it fires only on an approved gate.

### 7. Staging-first delivery; production promotion is a separate human gate
Per the researcher's recommendation and the product decision: the MVP delivers a running app to a **staging/preview URL** (US-11.7); promotion to production is a **separate, higher-privilege human-approved milestone** (US-11.8) performed by the Deployer, never the agent. Autonomous deploy-straight-to-prod is explicitly out of the MVP.

### 8. Merit integrity, enforced structurally
Agent Delivery imports nothing from Engagement/Scoring/Discovery, references none of their tables, and emits no event Scoring consumes. `src/modules/scoring-boundary.test.ts` forbids the run-table names and the `@/modules/agent-delivery` import in the four scoring/discovery source files (US-11.9, extending US-RG/US-10.4).

### 9. Synthetic data only for MVP
No beneficiary PII enters any third-party model in the MVP; real beneficiary data requires a signed DPA + residency controls (Release 2+). This also removes a major prompt-injection surface.

## What is decided now vs. still open

**Decided and implemented (foundation slice):** the bounded-context placement, the `compute_pledges` trigger, the currency-canonical reserve-before-spend ledger + DB CHECK, the deterministic orchestrator + provider abstraction + fake provider, the milestone-gate state machine, the platform-admin kill switch, and the structural merit-integrity guard. All provable offline (fake provider, no sandbox).

**Proposed / open (need devops + operational validation):**
- **Sandbox substrate** — Firecracker vs Kata vs gVisor vs a managed sandbox service. Biggest cost + safety unknown; blocks the *real* build phase (not the fake-provider foundation).
- **Delivered-app isolation granularity** — one isolated GCP project per app vs a shared "delivered-apps" project with per-app service accounts.
- **Billing integration** — when `ComputePledgeAccepted` places a real payment hold (Release 2).
- **First template** in the eligibility allow-list (US-11.12) — start with a single low-blast-radius shape (e.g. a static/JAMstack site or a golden-scaffold CRUD app).

## Consequences

- **Positive:** money overrun and merit contamination are impossible by construction, not by discipline; the risky steps (code exec, deploy-to-prod) are structurally gated; the foundation is fully testable without live models or infra; every decision maps to a product invariant.
- **Negative / cost:** net-new sandbox + isolated-hosting infra outside the existing Cloud Run estate (new operational surface and cost); a second isolation domain to secure and monitor; staging apps consume compute and need a lifecycle/teardown owner.
- **Deferred risk:** production-deploy reliability is unproven until staging eval data exists — which is exactly why prod promotion is staged behind its own human gate.
