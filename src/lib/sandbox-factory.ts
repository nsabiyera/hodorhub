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
