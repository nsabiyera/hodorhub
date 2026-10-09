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
      throw new Error(
        'CloudRunDeployer deploys staging only; production promotion is a separate gate (US-11.8).',
      );
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
