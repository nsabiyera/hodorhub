import { describe, it, expect } from 'vitest';
import { FakeSandboxRunner } from './fake-sandbox-runner';

describe('FakeSandboxRunner', () => {
  it('returns a passing build by default and records the request', async () => {
    const s = new FakeSandboxRunner();
    const r = await s.runBuild({ templateCode: 'static-site', designArtifact: 'd', code: 'c' });
    expect(r.testsPassed).toBe(true);
    expect(r.artifactRef).toBeTruthy();
    expect(s.calls).toHaveLength(1);
    expect(s.calls[0]!.templateCode).toBe('static-site');
  });

  it('honors an overridden result (e.g. failing tests)', async () => {
    const s = new FakeSandboxRunner({ testsPassed: false, log: 'boom' });
    const r = await s.runBuild({ templateCode: 't', designArtifact: null, code: 'c' });
    expect(r.testsPassed).toBe(false);
    expect(r.log).toBe('boom');
  });
});
