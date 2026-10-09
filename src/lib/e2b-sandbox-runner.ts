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
    // Lazy real factory: kept out of the constructor so the factory can build
    // adapters without E2B_API_KEY (tests, build). The e2b SDK's `commands.run`
    // throws `CommandExitError` on a non-zero exit rather than returning it in
    // the result — that's caught here and folded back into the E2bSandboxLike
    // contract (a failed test run is a reviewable outcome, not a thrown error).
    /* c8 ignore start */
    this.sandboxFactory ??= async ({ apiKey }) => {
      const { Sandbox, CommandExitError } = await import('e2b');
      const sbx = await Sandbox.create({ apiKey });
      return {
        writeFile: (path, content) => sbx.files.write(path, content).then(() => undefined),
        runCommand: async (cmd) => {
          try {
            const r = await sbx.commands.run(cmd);
            return { exitCode: r.exitCode, stdout: r.stdout, stderr: r.stderr };
          } catch (err) {
            if (err instanceof CommandExitError) {
              return { exitCode: err.exitCode, stdout: err.stdout, stderr: err.stderr };
            }
            throw err;
          }
        },
        readFileBytes: (path) => sbx.files.read(path, { format: 'bytes' }),
        kill: () => sbx.kill().then(() => undefined),
      };
    };
    /* c8 ignore stop */

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
