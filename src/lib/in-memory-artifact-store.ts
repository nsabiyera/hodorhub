import type { ArtifactStore } from './artifact-store';

/** Deterministic, offline ArtifactStore for tests — no cloud, no credentials. */
export class InMemoryArtifactStore implements ArtifactStore {
  private readonly blobs = new Map<string, Uint8Array>();

  async put(key: string, bytes: Uint8Array, _contentType: string): Promise<string> {
    const ref = `memory://${key}`;
    this.blobs.set(ref, bytes);
    return ref;
  }

  async get(ref: string): Promise<Uint8Array> {
    const bytes = this.blobs.get(ref);
    if (!bytes) throw new Error(`artifact not found: ${ref}`);
    return bytes;
  }
}
