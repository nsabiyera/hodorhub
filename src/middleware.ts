import { NextResponse, type NextRequest } from 'next/server';
import { resolveBrandFromHost, DEFAULT_BRAND } from '@/lib/tenant';
import { appHostFromBaseUrl, isNeutralPath } from '@/lib/routes';

/**
 * Runs on every request. Resolves the tenant/brand once and forwards it to the
 * app via a request header (US-10.11). Marketplace routes always render the
 * default brand — branding never leaks onto neutral surfaces (ARCHITECTURE.md §3).
 */
const APP_HOST = appHostFromBaseUrl(process.env.PUBLIC_BASE_URL ?? 'http://localhost:3000');

export function middleware(req: NextRequest) {
  const brand = resolveBrandFromHost(req.headers.get('host'), APP_HOST);
  const neutral = isNeutralPath(req.nextUrl.pathname);

  const tenant = neutral ? DEFAULT_BRAND : brand.tenant;
  const isDefault = neutral || brand.isDefault;

  const headers = new Headers(req.headers);
  headers.set('x-hodorhub-tenant', tenant);
  headers.set('x-hodorhub-brand-default', String(isDefault));

  return NextResponse.next({ request: { headers } });
}

export const config = {
  matcher: ['/((?!_next/static|_next/image|favicon.ico).*)'],
};
