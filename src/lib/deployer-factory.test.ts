import { describe, it, expect } from 'vitest';
import { getDeployer } from './deployer-factory';
import { FakeDeployer } from './fake-deployer';

describe('getDeployer', () => {
  it('returns a FakeDeployer for "fake"', () => {
    expect(getDeployer('fake')).toBeInstanceOf(FakeDeployer);
  });
  it('throws for an unknown name (no silent fake fallback)', () => {
    expect(() => getDeployer('firecracker')).toThrow(/not configured/i);
  });
  it('throws a Plan-B2 "not wired" error for "cloudrun" until the real ArtifactStore + deploy client is supplied', () => {
    expect(() => getDeployer('cloudrun')).toThrow(/Plan B2/i);
  });
});
