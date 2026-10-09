import type { SandboxRunner, SandboxBuildRequest, SandboxBuildResult } from './sandbox-runner';

/** Deterministic, offline SandboxRunner for tests — no real code execution. */
export class FakeSandboxRunner implements SandboxRunner {
  public readonly calls: SandboxBuildRequest[] = [];
  constructor(private readonly result: Partial<SandboxBuildResult> = {}) {}
  async runBuild(req: SandboxBuildRequest): Promise<SandboxBuildResult> {
    this.calls.push(req);
    return {
      testsPassed: this.result.testsPassed ?? true,
      log: this.result.log ?? 'fake build: 3 passed, 0 failed',
      artifactRef: this.result.artifactRef ?? `fake-artifact:${req.templateCode}`,
    };
  }
}
