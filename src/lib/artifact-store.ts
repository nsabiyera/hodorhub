/**
 * Credentialed handoff seam for agent-delivered build artifacts (Epic 11).
 * The build sandbox is credential-less, so it cannot push to a registry/bucket
 * itself: the sandbox runner reads the build output OUT of the sandbox and
 * `put`s it here; the privileged deployer `get`s it by ref. In-memory fake for
 * tests; a GCS-backed implementation lands in Plan B2.
 */
export interface ArtifactStore {
  /** Store bytes under a run-scoped key; returns an opaque ref (stored as milestone artifactRef). */
  put(key: string, bytes: Uint8Array, contentType: string): Promise<string>;
  /** Fetch previously stored bytes by ref; throws if the ref is unknown. */
  get(ref: string): Promise<Uint8Array>;
}
