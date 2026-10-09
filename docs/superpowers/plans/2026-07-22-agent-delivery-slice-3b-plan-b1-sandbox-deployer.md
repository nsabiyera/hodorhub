# Agent-Delivery Slice 3b — Plan B1: Real Sandbox + Deployer Adapters Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Replace the fake build-and-deploy layer with real adapters behind the existing `SandboxRunner` and `DeployerClient` seams — an **E2B**-backed sandbox that runs agent-generated code + tests, and a **Cloud Run** deployer that ships the build to a per-app staging service — plus harden the per-step budget reservation so real input tokens can never exceed a step's reserved estimate. All adapter logic is unit-testable against injected clients/fakes and mergeable now; the live GCP/E2B provisioning (terraform, the delivered-apps project, service accounts, real credentials, live deploy verification) is **Plan B2** (devops), outlined at the end.

**Architecture:** The orchestrator already reaches the build sandbox only through `SandboxRunner` (`src/lib/sandbox-runner.ts`) and staging deploy only through `DeployerClient` (`src/lib/deployer.ts`); the worker constructs both and injects them into `advanceRun` (`src/worker/index.ts`). This plan: (1) tightens the reservation math so reserved cost ≥ actual on *input* as well as output; (2) adds a small `ArtifactStore` seam so the credential-less sandbox can hand its build output to the privileged deployer without either the sandbox holding deploy creds or the deployer reaching into the sandbox; (3) adds `E2bSandboxRunner` and `CloudRunDeployer`, each depending on an injected structural client (lazy real client, exactly like `AnthropicModelProvider`); (4) adds `getSandboxRunner`/`getDeployer` factories (throw-don't-fallback, like `getModelProvider`) selected by env, wired into the worker. **No orchestrator control-flow, gate, ledger-schema, or UI change** beyond the reservation-math tightening in Task 1.

**Tech Stack:** TypeScript (Node ≥ 20, ESM, `@/` alias), `e2b` SDK (build sandbox), Google Cloud Run + Cloud Build client libraries (staging deploy — real client construction is B1 code but exercised live only in B2), Drizzle/Postgres, Vitest (unit + integration). Money is integer minor units (pence, GBP).

## Global Constraints

- **Node ≥ 20**, ESM, `@/` alias. Money = integer minor units (pence), GBP.
- **Least privilege is structural, not policed (ADR 0003 §6):** the build sandbox holds **no** HodorHub or GCP deploy credentials and has restricted egress; the deployer runs **outside** every agent's toolset under its own identity and is the only component that can deploy. The `ArtifactStore` handoff must not require the sandbox to hold deploy creds.
- **The budget ceiling must hold for input as well as output.** After Task 1, `estimateMaxCostMinor`'s reserved cost must be ≥ the phase's real cost on *both* dimensions: reserve output at the phase's `maxOutputTokens` (already true) and reserve input at a conservative **upper bound** = the phase's fixed scaffolding estimate **plus** the prior phase's `maxOutputTokens` (the prior artifact the prompt embeds is bounded by the output cap that produced it). The run-level DB `CHECK (consumed_minor + reserved_minor <= committed_minor)` on `run_budgets` remains the hard backstop and is not changed.
- **Adapters must be offline-unit-testable** — each real adapter (`E2bSandboxRunner`, `CloudRunDeployer`) takes an injected structural client so tests exercise the logic with a fake and never hit the network or a real cloud. The real vendor client is constructed **lazily on first use**, never in the constructor (mirrors `AnthropicModelProvider`: `new Anthropic()` throws without a key, and the factory constructs adapters in keyless test/build environments).
- **Factories throw for unknown names — never silently fall back to fake.** A run must never build/deploy "for free" on a fake while the operator believes real infra ran (mirrors `getModelProvider`).
- **`SandboxRunner` and `DeployerClient` interface signatures are FIXED** — do not change `src/lib/sandbox-runner.ts` or `src/lib/deployer.ts`. Adapters implement them as-is; extra dependencies go on the adapter constructor, not the interface.
- **Sandbox/deployer selection is process-level (worker env), independent of `run.provider`.** An operator may run real models with a fake deployer (the current Plan-A intermediate state) or any combination. Default every selector to `'fake'` so existing behavior is unchanged until an operator opts in.
- **Errors propagate.** Let a thrown sandbox/deploy error propagate out of `runBuild`/`deploy`; the orchestrator already treats a failed build/deploy phase as a halt. Do not swallow.
- **Integration tests run via `npm run test:integration`** (a separate Vitest config; the default `npm run test` excludes `*.integration.test.ts`). They need Postgres — prefix with `TEST_DATABASE_URL=postgres://hodorhub:hodorhub@localhost:5432/hodorhub_test DATABASE_URL=postgres://hodorhub:hodorhub@localhost:5432/hodorhub_test`, and run them through the **Bash tool** (the `VAR=val ...` inline-env prefix is bash syntax). The DB is already up and `hodorhub_test` already exists; `globalSetup` applies migrations automatically.

---

### Task 1: Tighten per-step budget reservation to cover input

**Files:**
- Modify: `src/modules/agent-delivery/budget-math.ts`
- Modify: `src/modules/agent-delivery/orchestrator.ts`
- Test: `src/modules/agent-delivery/budget-math.test.ts` (extend)
- Test: `src/modules/agent-delivery/orchestrator.integration.test.ts` (update any assertions on reserved amounts — needs Postgres)

**Interfaces:**
- Consumes: `ModelTier`, `ModelUsage` from `@/lib/model-provider`; `PHASE_SPECS` (in `orchestrator.ts`).
- Produces (unchanged signatures): `estimateMaxCostMinor(tier, promptTokens, maxOutputTokens, rates?)`, `actualCostMinor(...)`. Orchestrator's reservation call now passes a conservative `promptTokens` upper bound.

The fix: today `runCurrentPhase` reserves with `estimateMaxCostMinor(spec.tier, spec.promptTokens, spec.maxOutput)`, where `spec.promptTokens` is a fixed guess (requirements 1200, design 1800, build 4000). The design and build prompts embed the prior phase's approved artifact, whose token count is bounded by the prior phase's `maxOutput` (requirements 2000, design 3000). So the reserved input can be lower than the real input. Reserve against `spec.promptTokens + priorPhaseMaxOutput` instead — a conservative upper bound that keeps reserved ≥ actual on input.

- [ ] **Step 1: Write the failing tests**

Add to `src/modules/agent-delivery/budget-math.test.ts` a test locking the intent that reserving with a larger promptTokens upper bound covers a realistic actual input:
```ts
import { describe, it, expect } from 'vitest';
import { estimateMaxCostMinor, actualCostMinor } from './budget-math';

describe('reservation covers realistic input (Plan B1)', () => {
  it('reserving against (scaffolding + prior maxOutput) is >= actual when real input approaches the prior artifact cap', () => {
    // design phase: scaffolding guess 1800, prior (requirements) maxOutput 2000
    const tier = 'planner' as const;
    const reservedPromptTokens = 1800 + 2000; // conservative upper bound
    const reserved = estimateMaxCostMinor(tier, reservedPromptTokens, 3000);
    // real input near the cap: 1800 scaffolding + a ~2000-token prior artifact
    const actual = actualCostMinor(tier, { inputTokens: 3800, outputTokens: 3000, cacheTokens: 0 });
    expect(actual).toBeLessThanOrEqual(reserved);
  });
});
```

- [ ] **Step 2: Run — verify the new test passes already (it exercises budget-math, unchanged) and note it documents the required orchestrator behavior**

Run: `npm run test -- src/modules/agent-delivery/budget-math.test.ts`
Expected: PASS (budget-math math is unchanged; this test pins the relationship the orchestrator must now satisfy). The behavioural change is verified by the orchestrator integration test in Step 4–6.

- [ ] **Step 3: Implement the orchestrator reservation change**

In `src/modules/agent-delivery/orchestrator.ts`, locate `const estimate = estimateMaxCostMinor(spec.tier, spec.promptTokens, spec.maxOutput);` (~line 110). Replace the `promptTokens` argument with a conservative upper bound that adds the prior phase's output cap:
```ts
// Prior artifact embedded in this phase's prompt is bounded by the prior
// phase's output cap, so reserve input against scaffolding + that cap. This
// keeps reserved cost >= actual on INPUT as well as OUTPUT (Plan B1).
const priorPhase = PRIOR_PHASE[phase];
const priorMaxOutput = priorPhase ? PHASE_SPECS[priorPhase].maxOutput : 0;
const reservedPromptTokens = spec.promptTokens + priorMaxOutput;
const estimate = estimateMaxCostMinor(spec.tier, reservedPromptTokens, spec.maxOutput);
```
`PRIOR_PHASE` and `PHASE_SPECS` already exist in the file; `priorPhase` here is the same lookup used later for `priorArtifact` — reuse the existing `PRIOR_PHASE[phase]` (declare `priorMaxOutput`/`reservedPromptTokens` next to the estimate, without duplicating the later `priorPhase` block or moving it).

- [ ] **Step 4: Run the orchestrator integration test — expect assertions on reserved/consumed amounts to change**

Run: `TEST_DATABASE_URL=postgres://hodorhub:hodorhub@localhost:5432/hodorhub_test DATABASE_URL=postgres://hodorhub:hodorhub@localhost:5432/hodorhub_test npm run test:integration -- src/modules/agent-delivery/orchestrator.integration.test.ts`
Expected: any test asserting an exact reserved or remaining amount for the design/build phase now fails (reserved input grew). Requirements phase is unchanged (no prior phase → `priorMaxOutput = 0`).

- [ ] **Step 5: Update the integration-test assertions to the new reserved amounts**

Recompute the expected reserved/remaining values with the new `reservedPromptTokens` (fixture uses the `FakeModelProvider`, so actual usage is deterministic). Update only the numeric expectations that changed; do not weaken any assertion (still assert exact amounts). If a test asserted a budget-halt boundary, confirm it still halts for the right reason.

- [ ] **Step 6: Run both suites — verify pass; typecheck; commit**
```bash
npm run test -- src/modules/agent-delivery/budget-math.test.ts
TEST_DATABASE_URL=postgres://hodorhub:hodorhub@localhost:5432/hodorhub_test DATABASE_URL=postgres://hodorhub:hodorhub@localhost:5432/hodorhub_test npm run test:integration -- src/modules/agent-delivery/orchestrator.integration.test.ts
npm run typecheck
git add src/modules/agent-delivery/budget-math.ts src/modules/agent-delivery/orchestrator.ts src/modules/agent-delivery/budget-math.test.ts src/modules/agent-delivery/orchestrator.integration.test.ts
git commit -m "fix(agent-delivery): reserve input against prior-phase output cap (Plan B1 ceiling hardening)"
```

---

### Task 2: `ArtifactStore` seam + in-memory fake

**Files:**
- Create: `src/lib/artifact-store.ts`
- Create: `src/lib/in-memory-artifact-store.ts`
- Test: `src/lib/in-memory-artifact-store.test.ts`

**Interfaces:**
- Produces: `interface ArtifactStore { put(key: string, bytes: Uint8Array, contentType: string): Promise<string>; get(ref: string): Promise<Uint8Array>; }` and `class InMemoryArtifactStore implements ArtifactStore`. `put` returns an opaque `ref` string (the value stored as a run milestone's `artifactRef` and later read by the deployer). The real GCS-backed store is Plan B2.

Rationale: the build sandbox is credential-less, so it cannot push to a registry or bucket itself. The `E2bSandboxRunner` (Task 3) reads the build output *out* of the sandbox into the worker process, then `put`s it to the `ArtifactStore`; the `CloudRunDeployer` (Task 4) `get`s it by `ref`. The store is the credentialed handoff point, injected into both adapters.

- [ ] **Step 1: Write the failing test**

Create `src/lib/in-memory-artifact-store.test.ts`:
```ts
import { describe, it, expect } from 'vitest';
import { InMemoryArtifactStore } from './in-memory-artifact-store';

describe('InMemoryArtifactStore', () => {
  it('round-trips bytes by the ref it returns', async () => {
    const store = new InMemoryArtifactStore();
    const bytes = new TextEncoder().encode('build output');
    const ref = await store.put('run-1/build.tar.gz', bytes, 'application/gzip');
    expect(typeof ref).toBe('string');
    expect(ref.length).toBeGreaterThan(0);
    const got = await store.get(ref);
    expect(new TextDecoder().decode(got)).toBe('build output');
  });

  it('throws for an unknown ref (never returns stale/empty bytes silently)', async () => {
    const store = new InMemoryArtifactStore();
    await expect(store.get('nope')).rejects.toThrow(/not found/i);
  });

  it('uses the key in the ref so refs are traceable to a run', async () => {
    const store = new InMemoryArtifactStore();
    const ref = await store.put('run-42/build.tar.gz', new Uint8Array([1]), 'application/gzip');
    expect(ref).toContain('run-42');
  });
});
```

- [ ] **Step 2: Run — verify it fails**

Run: `npm run test -- src/lib/in-memory-artifact-store.test.ts`
Expected: FAIL — modules do not exist.

- [ ] **Step 3: Implement the interface and fake**

Create `src/lib/artifact-store.ts`:
```ts
/**
 * Credentialed handoff seam for agent-delivered build artifacts (Epic 11).
 * The build sandbox is credential-less, so it cannot push to a registry/bucket
 * itself: the sandbox runner reads the build output OUT of the sandbox and
 * `put`s it here; the privileged deployer `get`s it by ref. In-memory fake for
 * tests; a GCS-backed implementation lands in Plan B2.
 */
export interface ArtifactStore {
  /** Store bytes under a run-scoped key; returns an opaque ref (stored as milestone artifactRef). */
  put(key: string, bytes: Uint8Array, contentType: string): Promise<string>;
  /** Fetch previously stored bytes by ref; throws if the ref is unknown. */
  get(ref: string): Promise<Uint8Array>;
}
```

Create `src/lib/in-memory-artifact-store.ts`:
```ts
import type { ArtifactStore } from './artifact-store';

/** Deterministic, offline ArtifactStore for tests — no cloud, no credentials. */
export class InMemoryArtifactStore implements ArtifactStore {
  private readonly blobs = new Map<string, Uint8Array>();

  async put(key: string, bytes: Uint8Array, _contentType: string): Promise<string> {
    const ref = `memory://${key}`;
    this.blobs.set(ref, bytes);
    return ref;
  }

  async get(ref: string): Promise<Uint8Array> {
    const bytes = this.blobs.get(ref);
    if (!bytes) throw new Error(`artifact not found: ${ref}`);
    return bytes;
  }
}
```

- [ ] **Step 4: Run tests — verify pass; typecheck; commit**
```bash
npm run test -- src/lib/in-memory-artifact-store.test.ts
npm run typecheck
git add src/lib/artifact-store.ts src/lib/in-memory-artifact-store.ts src/lib/in-memory-artifact-store.test.ts
git commit -m "feat(agent-delivery): ArtifactStore seam + in-memory fake (Plan B1)"
```

---

### Task 3: `E2bSandboxRunner` — real build sandbox

**Files:**
- Modify: `package.json` (add `e2b` dependency)
- Modify: `src/config/env.ts` (add `E2B_API_KEY`)
- Create: `src/lib/e2b-sandbox-runner.ts`
- Test: `src/lib/e2b-sandbox-runner.test.ts`

**Interfaces:**
- Consumes: `SandboxRunner`, `SandboxBuildRequest`, `SandboxBuildResult` from `@/lib/sandbox-runner`; `ArtifactStore` from `@/lib/artifact-store`.
- Produces: `class E2bSandboxRunner implements SandboxRunner` with `constructor(deps: { artifactStore: ArtifactStore; sandboxFactory?: E2bSandboxFactory })` and an exported structural type `E2bSandboxFactory = (opts: { apiKey: string }) => Promise<E2bSandboxLike>` plus `interface E2bSandboxLike` (the minimal surface the adapter uses). Tests inject a fake `sandboxFactory`; the real factory (calling the `e2b` SDK) is built lazily.

Contract the adapter implements for `runBuild(req)`:
1. Create a sandbox (via the injected factory; real one uses `E2B_API_KEY`).
2. Write the template scaffold, the approved design artifact, and the model's `code` into the sandbox filesystem.
3. Run the template's test command; capture combined stdout+stderr as `log` and `testsPassed = exitCode === 0`.
4. Package the build output into a tarball inside the sandbox, read the tarball bytes out, `artifactStore.put(\`${req.templateCode}-build.tar.gz\`, bytes, 'application/gzip')` → `artifactRef`. **If the build failed (`!testsPassed`), still produce an artifactRef pointing at the (partial) output** so the log + failure are reviewable at the gate — do not throw on test failure (a failed build is a reviewable outcome, not an adapter error; only infrastructure faults throw).
5. Always kill/close the sandbox (try/finally), even on error.

- [ ] **Step 1: Add the dependency + env**

Run: `npm install e2b`
Add to `src/config/env.ts` zod object: `E2B_API_KEY: z.string().optional(),`

- [ ] **Step 2: Write the failing test**

Create `src/lib/e2b-sandbox-runner.test.ts`. Build a fake sandbox recording the files written and commands run, returning scripted results:
```ts
import { describe, it, expect } from 'vitest';
import { E2bSandboxRunner, type E2bSandboxLike } from './e2b-sandbox-runner';
import { InMemoryArtifactStore } from './in-memory-artifact-store';

function fakeSandbox(opts: { exitCode: number; tarball: Uint8Array }) {
  const writes: Array<{ path: string; content: string }> = [];
  const commands: string[] = [];
  let killed = false;
  const sbx: E2bSandboxLike = {
    async writeFile(path, content) { writes.push({ path, content }); },
    async runCommand(cmd) { commands.push(cmd); return { exitCode: opts.exitCode, stdout: `ran ${cmd}`, stderr: '' }; },
    async readFileBytes(_path) { return opts.tarball; },
    async kill() { killed = true; },
  };
  return { sbx, writes, commands, get killed() { return killed; } };
}

const baseReq = { templateCode: 'static-site', designArtifact: 'DESIGN', code: 'console.log(1)' };

describe('E2bSandboxRunner', () => {
  it('writes code, runs tests, stores the artifact, reports testsPassed on exit 0', async () => {
    const f = fakeSandbox({ exitCode: 0, tarball: new TextEncoder().encode('BUILD') });
    const store = new InMemoryArtifactStore();
    const runner = new E2bSandboxRunner({ artifactStore: store, sandboxFactory: async () => f.sbx });
    const res = await runner.runBuild(baseReq);
    expect(res.testsPassed).toBe(true);
    expect(res.log).toContain('ran');
    expect(res.artifactRef).toContain('static-site');
    expect(new TextDecoder().decode(await store.get(res.artifactRef))).toBe('BUILD');
    expect(f.writes.some((w) => w.content === 'console.log(1)')).toBe(true);
    expect(f.killed).toBe(true); // sandbox always torn down
  });

  it('reports testsPassed=false on non-zero exit but STILL stores an artifact (reviewable failure, no throw)', async () => {
    const f = fakeSandbox({ exitCode: 1, tarball: new TextEncoder().encode('PARTIAL') });
    const store = new InMemoryArtifactStore();
    const runner = new E2bSandboxRunner({ artifactStore: store, sandboxFactory: async () => f.sbx });
    const res = await runner.runBuild(baseReq);
    expect(res.testsPassed).toBe(false);
    expect(res.artifactRef).toBeTruthy();
  });

  it('always kills the sandbox even when a command throws', async () => {
    let killed = false;
    const sbx: E2bSandboxLike = {
      async writeFile() {},
      async runCommand() { throw new Error('sandbox exec failed'); },
      async readFileBytes() { return new Uint8Array(); },
      async kill() { killed = true; },
    };
    const runner = new E2bSandboxRunner({ artifactStore: new InMemoryArtifactStore(), sandboxFactory: async () => sbx });
    await expect(runner.runBuild(baseReq)).rejects.toThrow('sandbox exec failed');
    expect(killed).toBe(true);
  });
});
```

- [ ] **Step 3: Run — verify it fails**

Run: `npm run test -- src/lib/e2b-sandbox-runner.test.ts`
Expected: FAIL — module does not exist.

- [ ] **Step 4: Implement the adapter**

Create `src/lib/e2b-sandbox-runner.ts`:
```ts
import type { SandboxRunner, SandboxBuildRequest, SandboxBuildResult } from './sandbox-runner';
import type { ArtifactStore } from './artifact-store';
import { env } from '@/config/env';

/** Minimal sandbox surface the adapter uses — tests inject a fake of this. */
export interface E2bSandboxLike {
  writeFile(path: string, content: string): Promise<void>;
  runCommand(cmd: string): Promise<{ exitCode: number; stdout: string; stderr: string }>;
  readFileBytes(path: string): Promise<Uint8Array>;
  kill(): Promise<void>;
}

export type E2bSandboxFactory = (opts: { apiKey: string }) => Promise<E2bSandboxLike>;

// Command that produces /workspace/build.tar.gz and exits non-zero iff tests fail.
const BUILD_AND_TEST_CMD =
  'cd /workspace && (npm ci || npm install) && npm test 2>&1; rc=$?; tar czf build.tar.gz -C /workspace . ; exit $rc';

/**
 * Real build sandbox (Epic 11, Plan B1) backed by E2B. Runs agent-generated
 * code + the template's tests in an isolated, credential-less sandbox with
 * restricted egress, then hands the build output to the ArtifactStore (the
 * sandbox never holds deploy creds). The real E2B client is constructed lazily.
 */
export class E2bSandboxRunner implements SandboxRunner {
  private readonly artifactStore: ArtifactStore;
  private sandboxFactory: E2bSandboxFactory | undefined;

  constructor(deps: { artifactStore: ArtifactStore; sandboxFactory?: E2bSandboxFactory }) {
    this.artifactStore = deps.artifactStore;
    this.sandboxFactory = deps.sandboxFactory;
  }

  async runBuild(req: SandboxBuildRequest): Promise<SandboxBuildResult> {
    // Lazy real factory: confirm the exact `e2b` SDK calls against its docs when
    // wiring this (Sandbox.create / files.write / commands.run / files.read / kill).
    // Kept out of the constructor so the factory can build adapters without E2B_API_KEY.
    this.sandboxFactory ??= async ({ apiKey }) => {
      const { Sandbox } = await import('e2b');
      const sbx = await Sandbox.create({ apiKey });
      return {
        writeFile: (path, content) => sbx.files.write(path, content).then(() => undefined),
        runCommand: async (cmd) => {
          const r = await sbx.commands.run(cmd);
          return { exitCode: r.exitCode, stdout: r.stdout, stderr: r.stderr };
        },
        readFileBytes: (path) => sbx.files.read(path, { format: 'bytes' }) as Promise<Uint8Array>,
        kill: () => sbx.kill().then(() => undefined),
      };
    };

    const sbx = await this.sandboxFactory({ apiKey: env.E2B_API_KEY ?? '' });
    try {
      await sbx.writeFile('/workspace/DESIGN.md', req.designArtifact ?? '(none)');
      await sbx.writeFile('/workspace/agent-output.txt', req.code);
      const r = await sbx.runCommand(BUILD_AND_TEST_CMD);
      const testsPassed = r.exitCode === 0;
      const log = `${r.stdout}\n${r.stderr}`.trim();
      const tarball = await sbx.readFileBytes('/workspace/build.tar.gz');
      const artifactRef = await this.artifactStore.put(
        `${req.templateCode}-build.tar.gz`,
        tarball,
        'application/gzip',
      );
      return { testsPassed, log, artifactRef };
    } finally {
      await sbx.kill();
    }
  }
}
```
Note: the `import('e2b')` binding and the exact `files`/`commands` method names must be confirmed against the installed `e2b` SDK version — the adapter logic (tested above) is vendor-agnostic; only that one lazy factory block touches the SDK. If the SDK surface differs, adjust only inside the factory, keeping `E2bSandboxLike` stable.

- [ ] **Step 5: Run tests — verify pass; typecheck; commit**
```bash
npm run test -- src/lib/e2b-sandbox-runner.test.ts
npm run typecheck
git add package.json package-lock.json src/config/env.ts src/lib/e2b-sandbox-runner.ts src/lib/e2b-sandbox-runner.test.ts
git commit -m "feat(agent-delivery): E2B-backed SandboxRunner (Plan B1)"
```

---

### Task 4: `CloudRunDeployer` — real staging deployer

**Files:**
- Create: `src/lib/cloud-run-deployer.ts`
- Test: `src/lib/cloud-run-deployer.test.ts`

**Interfaces:**
- Consumes: `DeployerClient`, `DeployRequest`, `DeployResult` from `@/lib/deployer`; `ArtifactStore` from `@/lib/artifact-store`.
- Produces: `class CloudRunDeployer implements DeployerClient` with `constructor(deps: { artifactStore: ArtifactStore; deployClient: DeployClientLike; serviceName?: (runId: string) => string })` and an exported structural `interface DeployClientLike { deployFromArtifact(input: { runId: string; environment: 'staging'; serviceName: string; artifact: Uint8Array }): Promise<{ url: string; revisionRef: string }>; }`. The `DeployClientLike` is the boundary to real GCP (Cloud Build image build from the artifact + Cloud Run deploy under the per-app service account) — its real implementation is **Plan B2**; B1 tests inject a fake.

Contract the adapter implements for `deploy(req)`:
1. Reject `environment === 'production'` with a clear error — production promotion (US-11.8) is a separate privileged gate, out of scope for this deployer.
2. `artifactStore.get(req.artifactRef)` → build bytes.
3. Compute a deterministic per-app `serviceName` from `runId` (default `run-<runId>`; per-app SA + Cloud Run service, shared delivered-apps project).
4. `deployClient.deployFromArtifact({ runId, environment: 'staging', serviceName, artifact })` → `{ url, revisionRef }`; map straight to `DeployResult`.

- [ ] **Step 1: Write the failing test**

Create `src/lib/cloud-run-deployer.test.ts`:
```ts
import { describe, it, expect } from 'vitest';
import { CloudRunDeployer, type DeployClientLike } from './cloud-run-deployer';
import { InMemoryArtifactStore } from './in-memory-artifact-store';

function fakeDeployClient() {
  const calls: unknown[] = [];
  const client: DeployClientLike = {
    async deployFromArtifact(input) {
      calls.push(input);
      return { url: `https://${input.serviceName}.run.app`, revisionRef: `${input.serviceName}-00001` };
    },
  };
  return { client, calls };
}

describe('CloudRunDeployer', () => {
  it('fetches the artifact, deploys a per-run staging service, maps url + revisionRef', async () => {
    const store = new InMemoryArtifactStore();
    const ref = await store.put('run-7/build.tar.gz', new TextEncoder().encode('BUILD'), 'application/gzip');
    const f = fakeDeployClient();
    const deployer = new CloudRunDeployer({ artifactStore: store, deployClient: f.client });
    const res = await deployer.deploy({ runId: 'run-7', environment: 'staging', artifactRef: ref });
    expect(res.url).toContain('run-run-7');
    expect(res.revisionRef).toContain('run-run-7');
    const call = f.calls[0] as { serviceName: string; environment: string; artifact: Uint8Array };
    expect(call.serviceName).toBe('run-run-7');
    expect(call.environment).toBe('staging');
    expect(new TextDecoder().decode(call.artifact)).toBe('BUILD');
  });

  it('refuses production (separate privileged promotion gate, US-11.8)', async () => {
    const deployer = new CloudRunDeployer({ artifactStore: new InMemoryArtifactStore(), deployClient: fakeDeployClient().client });
    await expect(
      deployer.deploy({ runId: 'run-7', environment: 'production', artifactRef: 'memory://x' }),
    ).rejects.toThrow(/production/i);
  });

  it('propagates an unknown artifact ref (never deploys empty)', async () => {
    const deployer = new CloudRunDeployer({ artifactStore: new InMemoryArtifactStore(), deployClient: fakeDeployClient().client });
    await expect(
      deployer.deploy({ runId: 'run-7', environment: 'staging', artifactRef: 'memory://missing' }),
    ).rejects.toThrow(/not found/i);
  });
});
```

- [ ] **Step 2: Run — verify it fails**

Run: `npm run test -- src/lib/cloud-run-deployer.test.ts`
Expected: FAIL — module does not exist.

- [ ] **Step 3: Implement the adapter**

Create `src/lib/cloud-run-deployer.ts`:
```ts
import type { DeployerClient, DeployRequest, DeployResult } from './deployer';
import type { ArtifactStore } from './artifact-store';

/**
 * Boundary to real GCP: build a container image from the build artifact
 * (Cloud Build) and deploy it to a Cloud Run service under the delivered app's
 * own service account in the shared delivered-apps project. The REAL
 * implementation is Plan B2; B1 depends only on this structural interface.
 */
export interface DeployClientLike {
  deployFromArtifact(input: {
    runId: string;
    environment: 'staging';
    serviceName: string;
    artifact: Uint8Array;
  }): Promise<{ url: string; revisionRef: string }>;
}

/**
 * Privileged staging Deployer (Epic 11, Plan B1) — runs OUTSIDE every agent's
 * toolset under its own identity. Fetches the build artifact from the
 * ArtifactStore and deploys a per-run Cloud Run service (staging only;
 * production promotion is a separate gate, US-11.8).
 */
export class CloudRunDeployer implements DeployerClient {
  private readonly artifactStore: ArtifactStore;
  private readonly deployClient: DeployClientLike;
  private readonly serviceName: (runId: string) => string;

  constructor(deps: {
    artifactStore: ArtifactStore;
    deployClient: DeployClientLike;
    serviceName?: (runId: string) => string;
  }) {
    this.artifactStore = deps.artifactStore;
    this.deployClient = deps.deployClient;
    this.serviceName = deps.serviceName ?? ((runId) => `run-${runId}`);
  }

  async deploy(req: DeployRequest): Promise<DeployResult> {
    if (req.environment === 'production') {
      throw new Error('CloudRunDeployer deploys staging only; production promotion is a separate gate (US-11.8).');
    }
    const artifact = await this.artifactStore.get(req.artifactRef);
    const serviceName = this.serviceName(req.runId);
    const { url, revisionRef } = await this.deployClient.deployFromArtifact({
      runId: req.runId,
      environment: 'staging',
      serviceName,
      artifact,
    });
    return { url, revisionRef };
  }
}
```

- [ ] **Step 4: Run tests — verify pass; typecheck; commit**
```bash
npm run test -- src/lib/cloud-run-deployer.test.ts
npm run typecheck
git add src/lib/cloud-run-deployer.ts src/lib/cloud-run-deployer.test.ts
git commit -m "feat(agent-delivery): Cloud Run staging Deployer adapter (Plan B1)"
```

---

### Task 5: Sandbox/deployer factories + worker wiring

**Files:**
- Create: `src/lib/sandbox-factory.ts`
- Create: `src/lib/deployer-factory.ts`
- Test: `src/lib/sandbox-factory.test.ts`, `src/lib/deployer-factory.test.ts`
- Modify: `src/config/env.ts` (add `AGENT_DELIVERY_SANDBOX`, `AGENT_DELIVERY_DEPLOYER`)
- Modify: `src/worker/index.ts` (replace hardcoded fakes with the factories)

**Interfaces:**
- Produces: `getSandboxRunner(name: string): SandboxRunner` — `'fake'` → `new FakeSandboxRunner()`, `'e2b'` → `new E2bSandboxRunner({ artifactStore })`, else throw. `getDeployer(name: string): DeployerClient` — `'fake'` → `new FakeDeployer()`, `'cloudrun'` → `new CloudRunDeployer({ artifactStore, deployClient })`, else throw. Both throw for unknown names (no fake fallback), mirroring `getModelProvider`.

Note on the real deps: `'e2b'`/`'cloudrun'` need a real `ArtifactStore` (and the deployer a real `DeployClientLike`), which are **Plan B2** (GCS store + real GCP deploy client). In B1 the factories construct the real adapters with those real deps **lazily/at call time**, and B2 supplies them; until B2, selecting `'e2b'`/`'cloudrun'` will fail fast at first use for lack of a configured store/client — which is correct (throw-don't-fake). The default stays `'fake'`, so nothing changes for existing runs. Have the factory throw a clear "not yet wired (Plan B2)" error for the real branches if the B2 dependency is absent, rather than constructing a half-configured adapter.

- [ ] **Step 1: Write the failing factory tests**

Create `src/lib/sandbox-factory.test.ts`:
```ts
import { describe, it, expect } from 'vitest';
import { getSandboxRunner } from './sandbox-factory';
import { FakeSandboxRunner } from './fake-sandbox-runner';

describe('getSandboxRunner', () => {
  it('returns a FakeSandboxRunner for "fake"', () => {
    expect(getSandboxRunner('fake')).toBeInstanceOf(FakeSandboxRunner);
  });
  it('throws for an unknown name (no silent fake fallback)', () => {
    expect(() => getSandboxRunner('firecracker')).toThrow(/not configured/i);
  });
  it('throws a Plan-B2 "not wired" error for "e2b" until the real ArtifactStore is supplied', () => {
    expect(() => getSandboxRunner('e2b')).toThrow(/Plan B2/i);
  });
});
```
Create `src/lib/deployer-factory.test.ts` (mirror: `'fake'` → `FakeDeployer`; unknown → throws `/not configured/i`; `'cloudrun'` → throws `/Plan B2/i`).

- [ ] **Step 2: Run — verify they fail**

Run: `npm run test -- src/lib/sandbox-factory.test.ts src/lib/deployer-factory.test.ts`
Expected: FAIL — modules do not exist.

- [ ] **Step 3: Add env vars**

In `src/config/env.ts` zod object:
```ts
  AGENT_DELIVERY_SANDBOX: z.enum(['fake', 'e2b']).default('fake'),
  AGENT_DELIVERY_DEPLOYER: z.enum(['fake', 'cloudrun']).default('fake'),
```

- [ ] **Step 4: Implement the factories**

Create `src/lib/sandbox-factory.ts`:
```ts
import type { SandboxRunner } from './sandbox-runner';
import { FakeSandboxRunner } from './fake-sandbox-runner';

/**
 * Selects the build SandboxRunner named by AGENT_DELIVERY_SANDBOX. 'fake' is
 * deterministic/offline; 'e2b' runs agent code in a real E2B sandbox. Throws
 * for any other name — a run must never build "for free" on a fake while the
 * operator believes real infra ran (mirrors getModelProvider).
 */
export function getSandboxRunner(name: string): SandboxRunner {
  if (name === 'fake') return new FakeSandboxRunner();
  if (name === 'e2b') {
    // Real E2bSandboxRunner needs a real ArtifactStore (GCS) — Plan B2.
    throw new Error('sandbox "e2b" is not wired yet (Plan B2: real ArtifactStore + E2B account)');
  }
  throw new Error(`sandbox "${name}" is not configured`);
}
```
Create `src/lib/deployer-factory.ts` with the same shape: `'fake'` → `new FakeDeployer()`; `'cloudrun'` → throw `'deployer "cloudrun" is not wired yet (Plan B2: real ArtifactStore + GCP deploy client)'`; else throw `` `deployer "${name}" is not configured` ``.

- [ ] **Step 5: Wire the worker**

In `src/worker/index.ts`, replace the hardcoded `const deps = { sandbox: new FakeSandboxRunner(), deployer: new FakeDeployer() };` (~line 101) with:
```ts
const deps = {
  sandbox: getSandboxRunner(env.AGENT_DELIVERY_SANDBOX),
  deployer: getDeployer(env.AGENT_DELIVERY_DEPLOYER),
};
```
Update the imports: drop the direct `FakeSandboxRunner`/`FakeDeployer` imports if now unused, add `import { getSandboxRunner } from '@/lib/sandbox-factory';` and `import { getDeployer } from '@/lib/deployer-factory';`. Update the nearby comment so it states that sandbox/deployer are selected by env (default fake) and that `'e2b'`/`'cloudrun'` land in Plan B2.

- [ ] **Step 6: Verify — tests, typecheck, lint, build**
```bash
npm run test -- src/lib/sandbox-factory.test.ts src/lib/deployer-factory.test.ts
npm run typecheck && npm run lint && npm run build 2>&1 | tail -5
```
Expected: factory tests PASS; typecheck, lint, and `next build` succeed. (`AGENT_DELIVERY_SANDBOX`/`_DEPLOYER` are undefined under test/build via `schema.partial()`, so `getSandboxRunner(undefined)`… — guard: in the worker, default with `env.AGENT_DELIVERY_SANDBOX ?? 'fake'` so an undefined value under partial-schema still resolves to fake.)

- [ ] **Step 7: Commit**
```bash
git add src/lib/sandbox-factory.ts src/lib/deployer-factory.ts src/lib/sandbox-factory.test.ts src/lib/deployer-factory.test.ts src/config/env.ts src/worker/index.ts
git commit -m "feat(agent-delivery): sandbox/deployer factories + worker selection (Plan B1)"
```

---

## What Plan B1 delivers

Real, unit-tested build (`E2bSandboxRunner`) and staging-deploy (`CloudRunDeployer`) adapters behind the existing seams, a credentialed `ArtifactStore` handoff that keeps deploy creds out of the sandbox, a tightened per-step reservation that keeps the budget ceiling honest on input as well as output, and env-selected factories wired into the worker (default `'fake'`, so nothing changes until an operator opts in and Plan B2 supplies the real cloud dependencies). All mergeable and offline-verifiable.

## Plan B2 — deferred devops track (outline, not tasked here)

Needs GCP credentials, an E2B account, and devops sign-off; cannot be verified in this environment. Rough shape:
- **Terraform:** a shared, egress-restricted `delivered-apps` GCP project; Artifact Registry repo; a per-app **service-account + Cloud Run service** module; VPC/egress rules that deny any path to HodorHub's Cloud SQL / Memorystore / Secret Manager (ADR 0003 §6); the privileged **Deployer** identity (Cloud Run Job / SA holding deploy creds).
- **`GcsArtifactStore`** implementing `ArtifactStore` (bucket in the delivered-apps project), plus GCP env (`DELIVERED_APPS_PROJECT`, `DELIVERED_APPS_REGION`, `DELIVERED_APPS_ARTIFACT_BUCKET`).
- **Real `DeployClientLike`** — Cloud Build image build from the artifact tarball → deploy to the per-app Cloud Run service under its own SA → return the staging URL + revision.
- **Template scaffold into the sandbox** (surfaced by the Task 3 resume review, 2026-07-22): `E2bSandboxRunner.runBuild` currently writes only `DESIGN.md` + `agent-output.txt`, so a real `npm ci`/`npm test` in `/workspace` has no `package.json`/scaffold and would fail on every real build. B1's frozen `SandboxBuildRequest` carries no scaffold and the repo has no template-scaffold source. B2 must either (a) extend the request payload with the resolved scaffold, or (b) have the runner resolve a bundled template scaffold by `templateCode` and write it into the sandbox before running the build. Offline B1 tests don't exercise this (fake sandbox), so it's inert until real E2B builds run.
- **Wire the real deps** into `getSandboxRunner('e2b')` / `getDeployer('cloudrun')` (replace the "not wired yet" throws), configure E2B sandbox **egress restriction**, and set `AGENT_DELIVERY_SANDBOX=e2b` / `AGENT_DELIVERY_DEPLOYER=cloudrun`.
- **Admin kill-switch teardown** of real sandboxes + Cloud Run services (US-11.5) and **delivered-app export/handover** (US-11.7) against the real infra.
- **Live end-to-end smoke** with a real funded run: fund → accept → real model (Plan A) → real E2B build → real staging URL; verify budget draw-down, teardown, and isolation (delivered app has no path to HodorHub prod).

## Self-review notes

- **Spec coverage:** real sandbox (Task 3), real deployer (Task 4), artifact handoff (Task 2), selection + worker wiring (Task 5), ceiling hardening / logged follow-up (Task 1). The live-infra items ADR 0003 defers to devops are explicitly Plan B2.
- **Seam fidelity:** `SandboxRunner`/`DeployerClient` interfaces unchanged; adapters take extra deps on their constructors; factories mirror `getModelProvider` (throw-don't-fallback); adapters inject their vendor client and construct the real one lazily (mirrors `AnthropicModelProvider`).
- **Least privilege preserved:** the sandbox never holds deploy creds — it reads build output out and `put`s to the `ArtifactStore`; the privileged deployer `get`s and deploys. Production is refused by the staging deployer.
- **Ceiling:** Task 1 makes reserved ≥ actual on input by reserving against the prior phase's output cap; the run-level DB CHECK remains the hard backstop (unchanged).
- **Type/name consistency:** `ArtifactStore.put/get` refs flow sandbox → milestone `artifactRef` → deployer unchanged; `E2bSandboxLike`/`DeployClientLike` are the only vendor-specific surfaces and both have injected fakes.
- **Known caveats:** (1) selecting `'e2b'`/`'cloudrun'` before Plan B2 throws a clear "not wired yet" error by design (never a silent fake). (2) The `import('e2b')` factory block and the real GCP deploy client are the two spots whose exact SDK calls must be confirmed against vendor docs when B2 wires them — the tested adapter logic around them is vendor-agnostic. (3) Sandbox/deployer selection is process-level (worker env), deliberately independent of per-run `run.provider`, so real-model + fake-deploy stays a valid intermediate.
