import { describe, it, expect } from 'vitest';
import { InMemoryArtifactStore } from './in-memory-artifact-store';

describe('InMemoryArtifactStore', () => {
  it('round-trips bytes by the ref it returns', async () => {
    const store = new InMemoryArtifactStore();
    const bytes = new TextEncoder().encode('build output');
    const ref = await store.put('run-1/build.tar.gz', bytes, 'application/gzip');
    expect(typeof ref).toBe('string');
    expect(ref.length).toBeGreaterThan(0);
    const got = await store.get(ref);
    expect(new TextDecoder().decode(got)).toBe('build output');
  });

  it('throws for an unknown ref (never returns stale/empty bytes silently)', async () => {
    const store = new InMemoryArtifactStore();
    await expect(store.get('nope')).rejects.toThrow(/not found/i);
  });

  it('uses the key in the ref so refs are traceable to a run', async () => {
    const store = new InMemoryArtifactStore();
    const ref = await store.put('run-42/build.tar.gz', new Uint8Array([1]), 'application/gzip');
    expect(ref).toContain('run-42');
  });
});
