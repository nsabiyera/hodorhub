# HodorHub Delivery Team (subagents)

Seven role-based Claude Code subagents that design, build, and critique HodorHub together. Claude Code discovers them automatically from this folder (`.claude/agents/`); invoke one with the Task/Agent tool by its `name`, or let the orchestrator route by the `description`.

| Agent | `name` | Owns | Challenges others on |
|-------|--------|------|----------------------|
| Product Owner | `product-owner` | Backlog, user stories, scope, prioritisation, user value | Value, MVP scope, testable criteria |
| Software Architect | `software-architect` | System design, boundaries, data model, trade-offs | Feasibility, risk, cost of scope |
| Software Engineer | `software-engineer` | Implementation, tests, technical spikes | Implementability, story clarity, over-engineering |
| DevOps / Platform | `devops` | CI/CD, infra, secrets, observability, cost, reliability | Operability, deployability, security |
| QA | `qa` | Test strategy, edge cases, quality gates | Testability, defect & coverage risk |
| Agentic Systems Engineer | `agentic-engineer` | Agent orchestration, tool contracts, token-budget & review guardrails, evals, safety (Epic 11) | Runaway cost, missing human-in-the-loop, ungoverned tool access, merit leakage |
| Agentic Systems Researcher | `agentic-researcher` | Field research: orchestration patterns, model/provider evaluation, evals methodology, agent-safety & cost trends (feeds Epic 11) | Hype vs proven, lock-in & cost-trend risk, unsafe/unevaluated techniques |

## How they work together

They are built to **brainstorm and critique each other**, not rubber-stamp. A healthy loop:

1. **Product Owner** frames the need as stories with testable acceptance criteria.
2. **Architect** proposes a design and names the trade-offs and risks.
3. **Engineer** and **DevOps** pressure-test it for implementability and operability; propose simpler seams.
4. **QA** attacks the acceptance criteria and the invariants, defining how "done" is proven.
5. Disagreements are surfaced explicitly with reasoning; the loop repeats until the team converges.

To run a genuine multi-perspective debate, invoke several agents on the same question (in parallel for independent takes), then have each critique the others' output before converging. Each agent is instructed to end with **open questions / decisions needed** and to flag MVP blockers.

## Shared source of truth
All agents ground themselves in the repo's living docs: `PRODUCT_BACKLOG.md`, `ARCHITECTURE.md`, `SUPPORT_SCORE_MODEL.md`, `MONETISATION_MODEL.md`. They keep these consistent when decisions change.

## Product invariants every agent protects
- Charities & supporters never pay; corporations fund the platform.
- **Merit is never for sale** — scoring/ranking/discovery are payment- and brand-blind.
- The neutral public marketplace is never white-labelled.
- Donated hours count only once employer-approved.
