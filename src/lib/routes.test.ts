import { describe, it, expect } from 'vitest';
import { appHostFromBaseUrl, isNeutralPath } from './routes';

describe('appHostFromBaseUrl', () => {
  it('strips scheme, path, port and lowercases', () => {
    expect(appHostFromBaseUrl('https://HodorHub.com')).toBe('hodorhub.com');
    expect(appHostFromBaseUrl('http://localhost:3000')).toBe('localhost');
    expect(appHostFromBaseUrl('https://hodorhub.com:443/path')).toBe('hodorhub.com');
  });
});

describe('isNeutralPath', () => {
  it('treats the marketplace root and neutral sections as neutral', () => {
    expect(isNeutralPath('/')).toBe(true);
    expect(isNeutralPath('/discover')).toBe(true);
    expect(isNeutralPath('/projects/abc')).toBe(true);
    expect(isNeutralPath('/api/health')).toBe(true);
  });

  it('does not misclassify a path that merely starts with a neutral prefix string', () => {
    expect(isNeutralPath('/projectsology')).toBe(false);
    expect(isNeutralPath('/workspace')).toBe(false);
  });
});
