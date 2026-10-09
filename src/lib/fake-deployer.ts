import type { DeployerClient, DeployRequest, DeployResult } from './deployer';

/** Deterministic, offline DeployerClient for tests — no real deploy. */
export class FakeDeployer implements DeployerClient {
  public readonly calls: DeployRequest[] = [];
  constructor(private readonly result: Partial<DeployResult> = {}) {}
  async deploy(req: DeployRequest): Promise<DeployResult> {
    this.calls.push(req);
    return {
      url: this.result.url ?? `https://${req.runId}.preview.hodorhub.app`,
      revisionRef: this.result.revisionRef ?? `rev-${req.runId}`,
    };
  }
}
