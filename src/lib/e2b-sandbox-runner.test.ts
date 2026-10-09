import { describe, it, expect } from 'vitest';
import { E2bSandboxRunner, type E2bSandboxLike } from './e2b-sandbox-runner';
import { InMemoryArtifactStore } from './in-memory-artifact-store';

function fakeSandbox(opts: { exitCode: number; tarball: Uint8Array }) {
  const writes: Array<{ path: string; content: string }> = [];
  const commands: string[] = [];
  let killed = false;
  const sbx: E2bSandboxLike = {
    async writeFile(path, content) {
      writes.push({ path, content });
    },
    async runCommand(cmd) {
      commands.push(cmd);
      return { exitCode: opts.exitCode, stdout: `ran ${cmd}`, stderr: '' };
    },
    async readFileBytes(_path) {
      return opts.tarball;
    },
    async kill() {
      killed = true;
    },
  };
  return {
    sbx,
    writes,
    commands,
    get killed() {
      return killed;
    },
  };
}

const baseReq = { templateCode: 'static-site', designArtifact: 'DESIGN', code: 'console.log(1)' };

describe('E2bSandboxRunner', () => {
  it('writes code, runs tests, stores the artifact, reports testsPassed on exit 0', async () => {
    const f = fakeSandbox({ exitCode: 0, tarball: new TextEncoder().encode('BUILD') });
    const store = new InMemoryArtifactStore();
    const runner = new E2bSandboxRunner({
      artifactStore: store,
      sandboxFactory: async () => f.sbx,
    });
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
    const runner = new E2bSandboxRunner({
      artifactStore: store,
      sandboxFactory: async () => f.sbx,
    });
    const res = await runner.runBuild(baseReq);
    expect(res.testsPassed).toBe(false);
    expect(res.artifactRef).toBeTruthy();
  });

  it('always kills the sandbox even when a command throws', async () => {
    let killed = false;
    const sbx: E2bSandboxLike = {
      async writeFile() {},
      async runCommand() {
        throw new Error('sandbox exec failed');
      },
      async readFileBytes() {
        return new Uint8Array();
      },
      async kill() {
        killed = true;
      },
    };
    const runner = new E2bSandboxRunner({
      artifactStore: new InMemoryArtifactStore(),
      sandboxFactory: async () => sbx,
    });
    await expect(runner.runBuild(baseReq)).rejects.toThrow('sandbox exec failed');
    expect(killed).toBe(true);
  });

  it('kills the sandbox even when the build command throws (US-11.5/11.6 teardown)', async () => {
    const f = fakeSandbox({ exitCode: 0, tarball: new TextEncoder().encode('BUILD') });
    f.sbx.runCommand = async () => {
      throw new Error('sandbox exploded');
    };
    const runner = new E2bSandboxRunner({
      artifactStore: new InMemoryArtifactStore(),
      sandboxFactory: async () => f.sbx,
    });

    await expect(runner.runBuild(baseReq)).rejects.toThrow('sandbox exploded');
    expect(f.killed).toBe(true);
  });
});
