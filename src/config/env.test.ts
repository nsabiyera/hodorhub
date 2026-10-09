import { describe, it, expect } from 'vitest';
import { parseEnv } from './env';

const base = {
  PUBLIC_BASE_URL: 'http://localhost:3000',
  DATABASE_URL: 'postgres://u:p@localhost:5432/db',
  APP_ENCRYPTION_KEY: Buffer.alloc(32).toString('base64'),
  SESSION_SECRET: 'x'.repeat(32),
};

describe('parseEnv', () => {
  it('accepts a valid environment and applies defaults', () => {
    const env = parseEnv(base);
    expect(env.NODE_ENV).toBe('development');
    expect(env.SMTP_PORT).toBe(1025);
  });

  it('rejects an encryption key that is not 32 bytes', () => {
    expect(() => parseEnv({ ...base, APP_ENCRYPTION_KEY: 'dG9vc2hvcnQ=' })).toThrow();
  });

  it('rejects a short session secret', () => {
    expect(() => parseEnv({ ...base, SESSION_SECRET: 'tooshort' })).toThrow();
  });

  it('rejects a non-URL database url', () => {
    expect(() => parseEnv({ ...base, DATABASE_URL: 'not-a-url' })).toThrow();
  });
});
