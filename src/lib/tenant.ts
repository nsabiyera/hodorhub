/**
 * Tenant / brand resolution (ARCHITECTURE.md §3, US-10.11).
 *
 * MVP: the seam exists and always resolves to the DEFAULT HodorHub brand.
 * Corporate theming (Team) and custom domains (Enterprise) plug in here in
 * Release 2 without changing the request path. The neutral public marketplace
 * always resolves to the default brand regardless of host.
 *
 * `isDefault: false` means "candidate tenant host, NOT yet verified". Until a
 * host is matched against org_branding (Release 2), consumers must treat a
 * candidate as the default brand — so an unverified DNS record can never select
 * a real tenant brand.
 */
export const DEFAULT_BRAND = 'hodorhub' as const;

export interface ResolvedBrand {
  tenant: string; // organisation subdomain/domain, or DEFAULT_BRAND
  isDefault: boolean;
}

const DEFAULT: ResolvedBrand = { tenant: DEFAULT_BRAND, isDefault: true };

export function resolveBrandFromHost(host: string | null, appHost: string): ResolvedBrand {
  if (!host) return DEFAULT;

  const app = appHost.toLowerCase();
  const hostname = host.split(':')[0]!.toLowerCase();

  // Bare app host or www → neutral marketplace.
  if (hostname === app || hostname === `www.${app}`) return DEFAULT;

  // Subdomain of the app host, e.g. acme.hodorhub.com → tenant "acme".
  if (hostname.endsWith(`.${app}`)) {
    const sub = hostname.slice(0, -`.${app}`.length);
    // Empty / leading-dot / www subdomains are not tenants.
    if (!sub || sub === 'www') return DEFAULT;
    return { tenant: sub, isDefault: false };
  }

  // Otherwise a candidate custom domain (unverified until Release 2).
  return { tenant: hostname, isDefault: false };
}
