/**
 * Tool-contract seam for running agent-generated code in an isolated sandbox
 * (Epic 11). Mirrors the ModelProvider pattern: orchestration depends only on
 * this interface; a microVM-backed implementation lands in Slice 3b. The
 * sandbox holds no HodorHub credentials and has restricted egress.
 */
export interface SandboxBuildRequest {
  templateCode: string;
  designArtifact: string | null;
  code: string;
}
export interface SandboxBuildResult {
  testsPassed: boolean;
  log: string;
  artifactRef: string;
}
export interface SandboxRunner {
  runBuild(req: SandboxBuildRequest): Promise<SandboxBuildResult>;
}
