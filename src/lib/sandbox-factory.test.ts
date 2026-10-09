import { describe, it, expect } from 'vitest';
import { getSandboxRunner } from './sandbox-factory';
import { FakeSandboxRunner } from './fake-sandbox-runner';

describe('getSandboxRunner', () => {
  it('returns a FakeSandboxRunner for "fake"', () => {
    expect(getSandboxRunner('fake')).toBeInstanceOf(FakeSandboxRunner);
  });
  it('throws for an unknown name (no silent fake fallback)', () => {
    expect(() => getSandboxRunner('firecracker')).toThrow(/not configured/i);
  });
  it('throws a Plan-B2 "not wired" error for "e2b" until the real ArtifactStore is supplied', () => {
    expect(() => getSandboxRunner('e2b')).toThrow(/Plan B2/i);
  });
});
