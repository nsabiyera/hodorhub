import { describe, it, expect } from 'vitest';
import { resolveBrandFromHost, DEFAULT_BRAND } from './tenant';

const APP = 'hodorhub.com';

describe('resolveBrandFromHost', () => {
  it('resolves the bare app host to the neutral default brand', () => {
    expect(resolveBrandFromHost('hodorhub.com', APP)).toEqual({
      tenant: DEFAULT_BRAND,
      isDefault: true,
    });
  });

  it('treats www as the neutral marketplace', () => {
    expect(resolveBrandFromHost('www.hodorhub.com', APP).isDefault).toBe(true);
  });

  it('extracts a tenant from a subdomain', () => {
    expect(resolveBrandFromHost('acme.hodorhub.com', APP)).toEqual({
      tenant: 'acme',
      isDefault: false,
    });
  });

  it('treats an unrelated host as a candidate custom-domain tenant', () => {
    expect(resolveBrandFromHost('csr.acme.com', APP)).toEqual({
      tenant: 'csr.acme.com',
      isDefault: false,
    });
  });

  it('ignores the port and is case-insensitive on the host', () => {
    expect(resolveBrandFromHost('ACME.hodorhub.com:3000', APP).tenant).toBe('acme');
  });

  it('defaults when no host is present', () => {
    expect(resolveBrandFromHost(null, APP).isDefault).toBe(true);
  });

  // Regression: appHost must be normalised too, or the neutral marketplace host
  // resolves as a tenant (brand-neutrality violation).
  it('is case-insensitive on the app host', () => {
    expect(resolveBrandFromHost('hodorhub.com', 'HodorHub.com').isDefault).toBe(true);
  });

  // Regression: empty / leading-dot subdomains must not become empty tenants.
  it('treats an empty/leading-dot subdomain as default', () => {
    expect(resolveBrandFromHost('.hodorhub.com', APP)).toEqual(resolveBrandFromHost(null, APP));
    expect(resolveBrandFromHost('www.hodorhub.com', APP).tenant).toBe(DEFAULT_BRAND);
  });
});
