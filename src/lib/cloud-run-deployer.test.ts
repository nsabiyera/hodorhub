import { describe, it, expect } from 'vitest';
import { CloudRunDeployer, type DeployClientLike } from './cloud-run-deployer';
import { InMemoryArtifactStore } from './in-memory-artifact-store';

function fakeDeployClient() {
  const calls: unknown[] = [];
  const client: DeployClientLike = {
    async deployFromArtifact(input) {
      calls.push(input);
      return {
        url: `https://${input.serviceName}.run.app`,
        revisionRef: `${input.serviceName}-00001`,
      };
    },
  };
  return { client, calls };
}

describe('CloudRunDeployer', () => {
  it('fetches the artifact, deploys a per-run staging service, maps url + revisionRef', async () => {
    const store = new InMemoryArtifactStore();
    const ref = await store.put(
      'run-7/build.tar.gz',
      new TextEncoder().encode('BUILD'),
      'application/gzip',
    );
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
    const deployer = new CloudRunDeployer({
      artifactStore: new InMemoryArtifactStore(),
      deployClient: fakeDeployClient().client,
    });
    await expect(
      deployer.deploy({ runId: 'run-7', environment: 'production', artifactRef: 'memory://x' }),
    ).rejects.toThrow(/production/i);
  });

  it('propagates an unknown artifact ref (never deploys empty)', async () => {
    const deployer = new CloudRunDeployer({
      artifactStore: new InMemoryArtifactStore(),
      deployClient: fakeDeployClient().client,
    });
    await expect(
      deployer.deploy({ runId: 'run-7', environment: 'staging', artifactRef: 'memory://missing' }),
    ).rejects.toThrow(/not found/i);
  });
});
