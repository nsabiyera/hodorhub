/**
 * Pure request-routing helpers, extracted from middleware so they are unit-testable
 * without constructing a NextRequest.
 */

/** Derive the bare app hostname from a base URL, lowercased and port-stripped. */
export function appHostFromBaseUrl(baseUrl: string): string {
  return baseUrl
    .replace(/^https?:\/\//, '')
    .split('/')[0]!
    .split(':')[0]!
    .toLowerCase();
}

// Routes that are ALWAYS the neutral marketplace, whatever the host — branding
// must never leak onto them (ARCHITECTURE.md §3).
const NEUTRAL_PREFIXES = ['/discover', '/projects', '/api'];

/** True for the marketplace root and neutral sections (with correct path-boundary matching). */
export function isNeutralPath(pathname: string): boolean {
  if (pathname === '/') return true;
  return NEUTRAL_PREFIXES.some((p) => pathname === p || pathname.startsWith(`${p}/`));
}
