# Agent-Delivery Slice 3b (Plan A) — Real Claude ModelProvider Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Replace the fake-only model layer with a real Anthropic (Claude) `ModelProvider` behind the existing `getModelProvider` seam, calibrate the budget price book to real Claude pricing, and let an operator select the real provider per run — so agent-delivery runs drive real models while the sandbox and deployer stay on fakes.

**Architecture:** The orchestrator already depends only on the `ModelProvider` interface (`src/lib/model-provider.ts`) and reaches models exclusively through the `getModelProvider(name)` factory (`src/lib/model-provider-factory.ts`), which today wires only `'fake'` and throws for anything else. This plan adds a second implementation — `AnthropicModelProvider` — registers it in the factory under `'anthropic'`, calibrates `src/modules/agent-delivery/budget-math.ts` to real per-tier Claude rates, and makes `run.provider` selectable from an env var at run-creation time. **No orchestration, gate, budget-ledger, sandbox, deployer, or UI change** — those seams are untouched; the sandbox/deployer stay fake (that is Plan B).

**Tech Stack:** TypeScript (Node ≥ 20, ESM, `@/` alias), the official `@anthropic-ai/sdk`, Drizzle/Postgres, Vitest (unit + integration). Money is integer minor units (pence, GBP); display as `£(minor/100)`.

## Global Constraints

- **Node ≥ 20**, ESM, `@/` alias. Money = integer minor units (pence). Currency is GBP.
- **The reserve-before-spend ceiling must remain provable by construction — at the run level.** The HARD ceiling that makes runaway spend impossible (US-11.4) is the DB `CHECK (consumed_minor + reserved_minor <= committed_minor)` on `run_budgets`; that constraint is untouched by this slice and holds unconditionally. The *per-step* estimate (`estimateMaxCostMinor`) prices output at the requested `maxOutputTokens`, so a step's real OUTPUT cost never exceeds its reserved output estimate — but it prices INPUT at a fixed `promptTokens` guess, so a step's real input cost can slightly exceed that step's reserved estimate under the real provider (e.g. the design phase embeds the prior requirements artifact). That gap is bounded and caught by the run-level DB CHECK, not by the per-step estimate. Do not change that invariant — only recalibrate the rate numbers.
- **Model IDs (verbatim, do not append date suffixes):** planner → `claude-opus-4-8`, worker → `claude-sonnet-5`, reviewer → `claude-opus-4-8`.
- **Claude pricing (per 1M tokens, USD, standard/non-intro):** Opus 4.8 = $5 in / $25 out; Sonnet 5 = $3 in / $15 out. Calibrate to the **standard** Sonnet rate, never the intro rate (intro ends 2026-08-31; under-pricing after that would break the ceiling's real-money meaning).
- **Adaptive thinking is OFF in this MVP adapter** — set `thinking: { type: 'disabled' }` on every request. Opus 4.8 omitted-default is no-thinking, but Sonnet 5 omitted-default is adaptive-on, so set it explicitly on all tiers for predictable, bounded output. Enabling adaptive is a future tuning lever, out of scope here.
- **Never set `temperature`, `top_p`, or `top_k`** — they are removed on Opus 4.8 / Sonnet 5 and return a 400.
- **Do not use streaming.** Every phase's `maxOutput` is ≤ 8000 (`orchestrator.ts` PHASE_SPECS: requirements 2000, design 3000, build 8000), well under the ~16K non-streaming timeout threshold. Use `client.messages.create` (not `.stream`).
- **The adapter must be offline-unit-testable** — the `AnthropicModelProvider` constructor takes an injectable client so tests pass a fake with a stubbed `messages.create` (the repo runs no network in unit tests). Mirror the existing `FakeModelProvider` testability.
- **Auth:** the SDK resolves `ANTHROPIC_API_KEY` from the environment; construct the client with no explicit key argument. Never hardcode a key.
- **Errors:** let a thrown API error propagate out of `complete()`. The orchestrator already catches a thrown `provider.complete()`, releases the reservation, records an error step, and halts (`orchestrator.ts:157-177`) — do not swallow errors in the adapter.

---

### Task 1: Calibrate the budget price book to real Claude rates

**Files:**
- Modify: `src/modules/agent-delivery/budget-math.ts`
- Test: `src/modules/agent-delivery/budget-math.test.ts` (extend)

**Interfaces:**
- Consumes: `ModelTier` (`'planner' | 'worker' | 'reviewer'`), `ModelUsage` from `@/lib/model-provider`.
- Produces (unchanged signatures): `estimateMaxCostMinor(tier, promptTokens, maxOutputTokens, rates?)`, `actualCostMinor(tier, usage, rates?)`, exported `priceBook: Record<ModelTier, ModelRate>`, `PRICE_BOOK_VERSION: string`, and a new exported `USD_TO_GBP: number`.

Rate derivation (pence per 1M tokens = `USD_per_MTok × USD_TO_GBP × 100`, `USD_TO_GBP = 0.80`):
- planner / reviewer (Opus 4.8, $5/$25): `{ inputPerMTokens: 400, outputPerMTokens: 2000 }` — unchanged (already correct at 0.80).
- worker (Sonnet 5 standard, $3/$15): `{ inputPerMTokens: 240, outputPerMTokens: 1200 }` — **changed** from the current intro-priced `160/800`.

- [ ] **Step 1: Write the failing tests**

Add this block to `src/modules/agent-delivery/budget-math.test.ts`:
```ts
import { describe, it, expect } from 'vitest';
import { estimateMaxCostMinor, actualCostMinor, priceBook, PRICE_BOOK_VERSION, USD_TO_GBP } from './budget-math';

describe('price book calibration (Slice 3b)', () => {
  it('pins the calibrated version and FX', () => {
    expect(PRICE_BOOK_VERSION).toBe('2026-07-anthropic');
    expect(USD_TO_GBP).toBe(0.8);
  });

  it('prices Opus tiers (planner/reviewer) at $5/$25 → 400/2000 pence per MTok', () => {
    expect(priceBook.planner).toEqual({ inputPerMTokens: 400, outputPerMTokens: 2000 });
    expect(priceBook.reviewer).toEqual({ inputPerMTokens: 400, outputPerMTokens: 2000 });
  });

  it('prices the worker tier at Sonnet 5 STANDARD $3/$15 → 240/1200 (not intro 160/800)', () => {
    expect(priceBook.worker).toEqual({ inputPerMTokens: 240, outputPerMTokens: 1200 });
  });

  it('keeps the ceiling invariant: actual ≤ reserved when usage stays within the reserved max', () => {
    const tier = 'worker' as const;
    const promptTokens = 4000;
    const maxOutputTokens = 8000;
    const reserved = estimateMaxCostMinor(tier, promptTokens, maxOutputTokens);
    // real usage at or below the reserved bounds
    const actual = actualCostMinor(tier, { inputTokens: 4000, outputTokens: 8000, cacheTokens: 0 });
    expect(actual).toBeLessThanOrEqual(reserved);
  });
});
```

- [ ] **Step 2: Run — verify they fail**

Run: `npm run test -- src/modules/agent-delivery/budget-math.test.ts`
Expected: FAIL — `PRICE_BOOK_VERSION` is `'2026-07'`, `USD_TO_GBP` is undefined, `priceBook.worker` is `160/800`.

- [ ] **Step 3: Implement the calibration**

In `src/modules/agent-delivery/budget-math.ts`, replace the version constant and price book, and add the FX constant. Keep the doc comment's "calibrate against the live provider" spirit but record the real derivation:
```ts
export const PRICE_BOOK_VERSION = '2026-07-anthropic';

/**
 * Pinned USD→GBP conversion for the pence-denominated ledger. A documented
 * assumption, NOT a live FX feed — the ceiling guarantee (actual ≤ reserved)
 * is independent of this number because reservation and settlement use the
 * same priceBook. Update deliberately and bump PRICE_BOOK_VERSION when you do.
 */
export const USD_TO_GBP = 0.8;

export interface ModelRate {
  inputPerMTokens: number;
  outputPerMTokens: number;
}

/**
 * Price book: pence per 1,000,000 tokens, per tier.
 * Derived as USD_per_MTok × USD_TO_GBP × 100, at STANDARD (non-intro) Claude
 * rates so reservations stay safe after any promotional pricing ends:
 *   planner/reviewer → Claude Opus 4.8   ($5 in / $25 out)
 *   worker           → Claude Sonnet 5   ($3 in / $15 out, standard)
 */
export const priceBook: Record<ModelTier, ModelRate> = {
  planner: { inputPerMTokens: 400, outputPerMTokens: 2000 },
  worker: { inputPerMTokens: 240, outputPerMTokens: 1200 },
  reviewer: { inputPerMTokens: 400, outputPerMTokens: 2000 },
};
```
Leave `estimateMaxCostMinor` and `actualCostMinor` unchanged. (Note: `actualCostMinor` counts `cacheTokens` at the full input rate — cache reads are actually cheaper, so this over-charges slightly, which is the safe direction. Leave it.)

- [ ] **Step 4: Run tests — verify pass; typecheck**

Run: `npm run test -- src/modules/agent-delivery/budget-math.test.ts && npm run typecheck`
Expected: PASS; no type errors. (Existing `budget-math.test.ts` cases that assert on the old `160/800` numbers, if any, must be updated to `240/1200` in this same step — grep the file for `160` / `800` first.)

- [ ] **Step 5: Commit**
```bash
git add src/modules/agent-delivery/budget-math.ts src/modules/agent-delivery/budget-math.test.ts
git commit -m "feat(agent-delivery): calibrate price book to real Claude rates (Slice 3b)"
```

---

### Task 2: `AnthropicModelProvider` implementation

**Files:**
- Modify: `package.json` (add `@anthropic-ai/sdk` dependency)
- Modify: `src/config/env.ts` (add `ANTHROPIC_API_KEY`)
- Create: `src/lib/anthropic-model-provider.ts`
- Test: `src/lib/anthropic-model-provider.test.ts`

**Interfaces:**
- Consumes: `ModelProvider`, `ModelRequest`, `ModelResponse`, `ModelTier` from `@/lib/model-provider`.
- Produces: `class AnthropicModelProvider implements ModelProvider` with `constructor(client?: AnthropicClientLike)` and `async complete(req: ModelRequest): Promise<ModelResponse>`; exported `TIER_MODELS: Record<ModelTier, string>` and an `AnthropicClientLike` structural type (`{ messages: { create(args): Promise<{ content: Array<{type:string; text?:string}>; model: string; usage: {input_tokens:number; output_tokens:number; cache_read_input_tokens?:number}; stop_reason: string|null }> } }`) so tests inject a fake client without importing the SDK.

- [ ] **Step 1: Add the dependency**

Run: `npm install @anthropic-ai/sdk`
Expected: `@anthropic-ai/sdk` appears under `dependencies` in `package.json`; `package-lock.json` updated.

- [ ] **Step 2: Add the API key to the env schema**

In `src/config/env.ts`, add to the zod object (optional so `next build` and tests don't require it, matching the existing optional-secret pattern):
```ts
  ANTHROPIC_API_KEY: z.string().optional(),
```

- [ ] **Step 3: Write the failing test**

Create `src/lib/anthropic-model-provider.test.ts`:
```ts
import { describe, it, expect } from 'vitest';
import { AnthropicModelProvider, TIER_MODELS } from './anthropic-model-provider';
import type { ModelRequest } from './model-provider';

/** Records the args it was called with and returns a scripted response. */
function fakeClient(response: unknown) {
  const calls: unknown[] = [];
  return {
    calls,
    client: {
      messages: {
        create: async (args: unknown) => {
          calls.push(args);
          return response;
        },
      },
    },
  };
}

const baseReq: ModelRequest = {
  tier: 'planner',
  system: 'sys',
  prompt: 'do the thing',
  maxOutputTokens: 2000,
};

describe('AnthropicModelProvider', () => {
  it('maps tiers to the correct Claude model ids', () => {
    expect(TIER_MODELS).toEqual({
      planner: 'claude-opus-4-8',
      worker: 'claude-sonnet-5',
      reviewer: 'claude-opus-4-8',
    });
  });

  it('sends model, max_tokens, system, a single user message, and disabled thinking; no sampling params', async () => {
    const f = fakeClient({
      content: [{ type: 'text', text: 'hello' }],
      model: 'claude-opus-4-8',
      usage: { input_tokens: 10, output_tokens: 5 },
      stop_reason: 'end_turn',
    });
    const provider = new AnthropicModelProvider(f.client);
    await provider.complete({ ...baseReq, tier: 'worker', maxOutputTokens: 8000 });
    const args = f.calls[0] as Record<string, unknown>;
    expect(args.model).toBe('claude-sonnet-5');
    expect(args.max_tokens).toBe(8000);
    expect(args.system).toBe('sys');
    expect(args.messages).toEqual([{ role: 'user', content: 'do the thing' }]);
    expect(args.thinking).toEqual({ type: 'disabled' });
    expect(args).not.toHaveProperty('temperature');
    expect(args).not.toHaveProperty('top_p');
    expect(args).not.toHaveProperty('top_k');
  });

  it('concatenates text blocks, maps usage (cache→cacheTokens), and reports modelId', async () => {
    const f = fakeClient({
      content: [
        { type: 'text', text: 'part one ' },
        { type: 'thinking', thinking: 'ignored' },
        { type: 'text', text: 'part two' },
      ],
      model: 'claude-opus-4-8',
      usage: { input_tokens: 100, output_tokens: 200, cache_read_input_tokens: 40 },
      stop_reason: 'end_turn',
    });
    const provider = new AnthropicModelProvider(f.client);
    const res = await provider.complete(baseReq);
    expect(res.text).toBe('part one part two');
    expect(res.modelId).toBe('claude-opus-4-8');
    expect(res.usage).toEqual({ inputTokens: 100, outputTokens: 200, cacheTokens: 40 });
    expect(res.stopReason).toBe('end');
  });

  it('maps stop reasons: max_tokens/refusal/stop_sequence pass through, unknown → end', async () => {
    const mk = (stop: string) =>
      new AnthropicModelProvider(
        fakeClient({ content: [{ type: 'text', text: 'x' }], model: 'm', usage: { input_tokens: 1, output_tokens: 1 }, stop_reason: stop }).client,
      ).complete(baseReq);
    expect((await mk('max_tokens')).stopReason).toBe('max_tokens');
    expect((await mk('refusal')).stopReason).toBe('refusal');
    expect((await mk('stop_sequence')).stopReason).toBe('stop_sequence');
    expect((await mk('tool_use')).stopReason).toBe('end');
    expect((await mk('end_turn')).stopReason).toBe('end');
  });

  it('propagates a thrown API error (orchestrator releases + halts)', async () => {
    const provider = new AnthropicModelProvider({
      messages: { create: async () => { throw new Error('429 rate limited'); } },
    });
    await expect(provider.complete(baseReq)).rejects.toThrow('429 rate limited');
  });
});
```

- [ ] **Step 4: Run — verify it fails**

Run: `npm run test -- src/lib/anthropic-model-provider.test.ts`
Expected: FAIL — module `./anthropic-model-provider` does not exist.

- [ ] **Step 5: Implement the provider**

Create `src/lib/anthropic-model-provider.ts`:
```ts
import Anthropic from '@anthropic-ai/sdk';
import type { ModelProvider, ModelRequest, ModelResponse, ModelTier } from './model-provider';

/**
 * Real Claude ModelProvider (Epic 11, Slice 3b). Orchestration depends only on
 * the ModelProvider interface; this maps each tier to a Claude model, reports
 * real token usage to the budget ledger, and disables thinking for bounded,
 * predictable output. Sandbox and deployer remain fake (Plan B).
 */
export const TIER_MODELS: Record<ModelTier, string> = {
  planner: 'claude-opus-4-8',
  worker: 'claude-sonnet-5',
  reviewer: 'claude-opus-4-8',
};

/** Minimal structural shape of the Anthropic client so tests can inject a fake. */
export interface AnthropicClientLike {
  messages: {
    create(args: {
      model: string;
      max_tokens: number;
      system?: string;
      thinking: { type: 'disabled' };
      messages: Array<{ role: 'user'; content: string }>;
    }): Promise<{
      content: Array<{ type: string; text?: string }>;
      model: string;
      usage: { input_tokens: number; output_tokens: number; cache_read_input_tokens?: number };
      stop_reason: string | null;
    }>;
  };
}

function mapStopReason(reason: string | null): ModelResponse['stopReason'] {
  switch (reason) {
    case 'max_tokens':
      return 'max_tokens';
    case 'stop_sequence':
      return 'stop_sequence';
    case 'refusal':
      return 'refusal';
    default:
      // end_turn, tool_use, pause_turn (not expected — no tools), null → 'end'
      return 'end';
  }
}

export class AnthropicModelProvider implements ModelProvider {
  private client: AnthropicClientLike | undefined;

  // Optional injected client (tests pass a fake). When omitted, the real SDK
  // client is constructed LAZILY on first complete() — never at construction —
  // because `new Anthropic()` throws if ANTHROPIC_API_KEY is unset, and the
  // factory constructs this provider in environments (tests, build) with no key.
  constructor(client?: AnthropicClientLike) {
    this.client = client;
  }

  async complete(req: ModelRequest): Promise<ModelResponse> {
    // Lazy init: resolves ANTHROPIC_API_KEY from the environment (no key arg).
    this.client ??= new Anthropic() as unknown as AnthropicClientLike;
    const response = await this.client.messages.create({
      model: TIER_MODELS[req.tier],
      max_tokens: req.maxOutputTokens,
      system: req.system,
      thinking: { type: 'disabled' },
      messages: [{ role: 'user', content: req.prompt }],
    });

    const text = response.content
      .filter((b) => b.type === 'text' && typeof b.text === 'string')
      .map((b) => b.text as string)
      .join('');

    return {
      text,
      modelId: response.model,
      usage: {
        inputTokens: response.usage.input_tokens,
        outputTokens: response.usage.output_tokens,
        cacheTokens: response.usage.cache_read_input_tokens ?? 0,
      },
      stopReason: mapStopReason(response.stop_reason),
    };
  }
}
```

- [ ] **Step 6: Run tests — verify pass; typecheck; commit**
```bash
npm run test -- src/lib/anthropic-model-provider.test.ts
npm run typecheck
git add package.json package-lock.json src/config/env.ts src/lib/anthropic-model-provider.ts src/lib/anthropic-model-provider.test.ts
git commit -m "feat(agent-delivery): real Anthropic (Claude) ModelProvider (Slice 3b)"
```

---

### Task 3: Wire the factory, select the provider per run, verify

**Files:**
- Modify: `src/lib/model-provider-factory.ts`
- Modify: `src/lib/model-provider-factory.test.ts`
- Modify: `src/modules/agent-delivery/service.ts` (the run insert in `createRunFromPledge`)
- Modify: `src/config/env.ts` (add `AGENT_DELIVERY_PROVIDER`)

**Interfaces:**
- Consumes: `AnthropicModelProvider` (Task 2), `FakeModelProvider`.
- Produces: `getModelProvider('anthropic')` → `AnthropicModelProvider`; `getModelProvider('fake')` → `FakeModelProvider`; any other name still throws. A run created by `createRunFromPledge` gets `provider` from `env.AGENT_DELIVERY_PROVIDER` (default `'fake'`).

- [ ] **Step 1: Write the failing factory test**

Replace the "throws for anything else" case in `src/lib/model-provider-factory.test.ts` and add an anthropic case:
```ts
import { describe, it, expect } from 'vitest';
import { FakeModelProvider } from './fake-model-provider';
import { AnthropicModelProvider } from './anthropic-model-provider';
import { getModelProvider } from './model-provider-factory';

describe('getModelProvider', () => {
  it('returns a FakeModelProvider for "fake"', () => {
    expect(getModelProvider('fake')).toBeInstanceOf(FakeModelProvider);
  });

  it('returns an AnthropicModelProvider for "anthropic"', () => {
    expect(getModelProvider('anthropic')).toBeInstanceOf(AnthropicModelProvider);
  });

  it('throws for an unknown provider name', () => {
    expect(() => getModelProvider('bedrock')).toThrow(
      'model provider "bedrock" is not configured',
    );
  });
});
```
(`AnthropicModelProvider` constructs its SDK client lazily — the constructor with no client argument stores `undefined` and does NOT call `new Anthropic()`; the real client is built on first `complete()`. So `getModelProvider('anthropic')` needs no `ANTHROPIC_API_KEY` and this test is offline-safe.)

- [ ] **Step 2: Run — verify it fails**

Run: `npm run test -- src/lib/model-provider-factory.test.ts`
Expected: FAIL — factory throws for `'anthropic'`.

- [ ] **Step 3: Implement the factory wiring**

Replace `src/lib/model-provider-factory.ts`:
```ts
import type { ModelProvider } from './model-provider';
import { FakeModelProvider } from './fake-model-provider';
import { AnthropicModelProvider } from './anthropic-model-provider';

/**
 * Constructs the ModelProvider named on an agent_delivery_runs row
 * (`run.provider`). 'fake' is deterministic/offline; 'anthropic' drives real
 * Claude models (Slice 3b). Any other name throws rather than silently falling
 * back to fake — a run must never run "for free" on a fake while the operator
 * believes it is billing real usage.
 */
export function getModelProvider(name: string): ModelProvider {
  if (name === 'fake') return new FakeModelProvider();
  if (name === 'anthropic') return new AnthropicModelProvider();
  throw new Error(`model provider "${name}" is not configured`);
}
```

- [ ] **Step 4: Add the run-provider env var**

In `src/config/env.ts`, add to the zod object:
```ts
  AGENT_DELIVERY_PROVIDER: z.enum(['fake', 'anthropic']).default('fake'),
```

- [ ] **Step 5: Select the provider when creating a run**

In `src/modules/agent-delivery/service.ts`, find the `insert(agentDeliveryRuns)` call inside `createRunFromPledge` (grep: `priceBookVersion` and `insert(agentDeliveryRuns)`). It currently omits `provider`, so runs default to `'fake'` at the DB level. Add an explicit `provider` so an operator can flip real delivery on without a schema change or UI change:
```ts
// at the top of the file, with the other imports
import { env } from '@/config/env';

// …inside the values({...}) of the agentDeliveryRuns insert, add:
      provider: env.AGENT_DELIVERY_PROVIDER,
```
Leave `priceBookVersion` set exactly as it is today. This keeps provider selection an ops/config decision (merit-blind, invisible to scoring and the UI) — the UI and gates are unchanged.

- [ ] **Step 6: Verify — test, typecheck, lint, build**
```bash
npm run test -- src/lib/model-provider-factory.test.ts
npm run typecheck && npm run lint && npm run build 2>&1 | tail -5
```
Expected: factory tests PASS; typecheck, lint, and `next build` all succeed.

- [ ] **Step 7: Commit**
```bash
git add src/lib/model-provider-factory.ts src/lib/model-provider-factory.test.ts src/modules/agent-delivery/service.ts src/config/env.ts
git commit -m "feat(agent-delivery): register anthropic provider + per-run provider selection (Slice 3b)"
```

- [ ] **Step 8: (Optional, costs real money — gate on the user) Live smoke test**

Requires a real `ANTHROPIC_API_KEY` and `AGENT_DELIVERY_PROVIDER=anthropic` in `.env.local`, plus Postgres and the worker running (the worker loads env via `tsx --env-file=.env.local src/worker/index.ts`). Do NOT run this without the user's go-ahead — it bills real tokens.

Drive one run to the requirements gate as the seed corp/charity (same flow as the Slice-3a-frontend live drive): fund → accept → the worker advances the run, now calling **real Claude**. Confirm: the requirements milestone reaches `awaiting_review` with a non-empty `artifactRef`, the run budget's `consumedMinor` moved by a small non-zero amount, and `agent_steps` records real `inputTokens`/`outputTokens`/`costMinor`. The build phase still uses the **fake** sandbox (Plan B), so the run completes end-to-end with real model output but a fake build/deploy. Report the actual budget-line numbers observed.

---

## What this slice delivers

Agent-delivery runs can drive **real Claude models** (Opus 4.8 planner/reviewer, Sonnet 5 worker) through the existing orchestrator, gates, and reserve-before-spend budget ceiling — with the ceiling calibrated to real Claude pricing. An operator flips real delivery on per-deployment via `AGENT_DELIVERY_PROVIDER=anthropic`; nothing else changes. The sandbox (build execution) and deployer stay fake.

## Explicitly out of scope (Plan B / later)

Real `SandboxRunner` (microVM/managed sandbox for the build phase) and real `DeployerClient` (privileged Cloud Run staging deploy); the isolated "delivered-apps" GCP project; delivered-app export/handover; production-promotion gate (US-11.8); admin kill-switch UI; real beneficiary data (MVP stays synthetic-only, US-11.11); Billing's real money movement (Release 2); adaptive-thinking / effort tuning; a live FX feed; and content-versioning of the price book (only the version string is bumped here).

## Self-review notes

- **Spec coverage:** real ModelProvider (Task 2), factory registration (Task 3), rate calibration (Task 1), per-run provider selection (Task 3). These are exactly the "real provider adapters" + "calibrate budget-math" items ADR 0003 defers to Slice 3b for the model layer; sandbox/deployer are correctly excluded.
- **Ceiling invariant preserved:** reservation and settlement still share one `priceBook`; only the numbers changed. Test in Task 1 asserts actual ≤ reserved.
- **Offline testability:** the adapter injects a client; the factory test constructs the real adapter without a network call or key (key is used only in `complete()`). No test hits the network.
- **Type/name consistency:** `TIER_MODELS` keys match `ModelTier`; `ModelResponse.stopReason` union (`'end'|'max_tokens'|'stop_sequence'|'refusal'`) is exactly what `mapStopReason` produces; `ModelUsage` fields (`inputTokens`/`outputTokens`/`cacheTokens`) match what `actualCostMinor` consumes.
- **Known caveats (documented, not fixed here):** (1) a Claude `refusal` returns HTTP 200 with empty/partial text, not an exception — the run will settle and produce a thin artifact the charity reviews at the gate, rather than halting; acceptable for MVP. (2) `actualCostMinor` prices `cacheTokens` at the full input rate (over-charges cache reads) — safe direction. (3) Bumping `PRICE_BOOK_VERSION` does not reprice runs that already pinned the old string; only fresh runs (post-deploy) use the calibrated rates — acceptable since real runs start after this ships. (4) A settle that would tip cumulative `consumed+reserved` past `committed` rolls back the settle transaction — tokens already billed go unrecorded, and the run stays runnable so the phase is retried; a low-probability edge (the real provider's actual input can exceed the fixed `promptTokens` guess, see the ceiling-invariant constraint above) to close in a Plan-B follow-up by reserving input against the prior phase's `maxOutput` rather than a fixed guess.
