/**
 * Tool-contract seam for the privileged Deployer (Epic 11) — deploys a built
 * artifact to a staging/production URL. Runs OUTSIDE every agent's toolset
 * under its own identity; a real Cloud Run deployer lands in Slice 3b.
 */
export interface DeployRequest {
  runId: string;
  environment: 'staging' | 'production';
  artifactRef: string;
}
export interface DeployResult {
  url: string;
  revisionRef: string;
}
export interface DeployerClient {
  deploy(req: DeployRequest): Promise<DeployResult>;
}
