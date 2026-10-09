import { describe, it, expect } from 'vitest';
import { FakeDeployer } from './fake-deployer';

describe('FakeDeployer', () => {
  it('returns a staging URL and records the request', async () => {
    const d = new FakeDeployer();
    const r = await d.deploy({ runId: 'run-1', environment: 'staging', artifactRef: 'a' });
    expect(r.url).toContain('run-1');
    expect(r.revisionRef).toBeTruthy();
    expect(d.calls[0]!.environment).toBe('staging');
  });
});
