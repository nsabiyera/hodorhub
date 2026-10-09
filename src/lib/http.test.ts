import { describe, it, expect, vi } from 'vitest';
import { ZodError, z } from 'zod';
import { errorResponse, readJson, clientIp, enforceLimit, HttpError } from './http';
import {
  EmailInUseError,
  InvalidWorkEmailError,
  NotFoundError,
  InvalidStateError,
  InvalidCredentialsError,
  NotVerifiedError,
  ForbiddenError,
} from '@/modules/identity/errors';
import {
  InvalidProjectTransitionError,
  ProjectValidationError,
  NoResourceNeedsError,
} from '@/modules/projects/errors';
import { PreferenceLockedError } from '@/modules/notifications/preferences';
import { NoRelationshipError } from '@/modules/messaging';

describe('errorResponse — domain error → HTTP status mapping', () => {
  const cases: [Error, number, string][] = [
    [new EmailInUseError(), 409, 'email_in_use'],
    [new InvalidWorkEmailError('acme.com'), 422, 'invalid_work_email'],
    [new NotFoundError('Project'), 404, 'not_found'],
    [new InvalidStateError('x'), 409, 'invalid_state'],
    [new InvalidCredentialsError(), 401, 'invalid_credentials'],
    [new NotVerifiedError(), 403, 'not_verified'],
    [new ForbiddenError(), 403, 'forbidden'],
    [new InvalidProjectTransitionError('draft', 'completed'), 409, 'invalid_transition'],
    [new ProjectValidationError(['goal']), 422, 'project_validation'],
    [new NoResourceNeedsError(), 422, 'no_resource_needs'],
    [new PreferenceLockedError('x'), 422, 'preference_locked'],
    [new NoRelationshipError(), 403, 'no_relationship'],
  ];

  it.each(cases)('%s → %i', async (err, status, code) => {
    const res = errorResponse(err);
    expect(res.status).toBe(status);
    expect((await res.json()).error).toBe(code);
  });

  it('maps ZodError → 400 validation with details', async () => {
    let zerr: ZodError;
    try {
      z.object({ a: z.string() }).parse({});
      throw new Error('should have thrown');
    } catch (e) {
      zerr = e as ZodError;
    }
    const res = errorResponse(zerr);
    expect(res.status).toBe(400);
    expect((await res.json()).error).toBe('validation');
  });

  it('maps HttpError to its own status (401/403/429)', async () => {
    expect(errorResponse(new HttpError(401, 'unauthenticated')).status).toBe(401);
    expect(errorResponse(new HttpError(429, 'rate_limited')).status).toBe(429);
  });

  it('maps an unknown error → 500 without leaking details', async () => {
    const res = errorResponse(new Error('boom: secret internals'));
    expect(res.status).toBe(500);
    const body = await res.json();
    expect(body.error).toBe('internal');
    expect(JSON.stringify(body)).not.toContain('secret internals');
  });
});

describe('readJson', () => {
  it('parses a JSON body', async () => {
    const req = new Request('http://x', { method: 'POST', body: '{"a":1}' });
    expect(await readJson(req)).toEqual({ a: 1 });
  });
  it('throws HttpError(400) on invalid JSON', async () => {
    const req = new Request('http://x', { method: 'POST', body: 'not json' });
    await expect(readJson(req)).rejects.toBeInstanceOf(HttpError);
  });
});

describe('clientIp', () => {
  it('takes the first x-forwarded-for entry', () => {
    const req = new Request('http://x', { headers: { 'x-forwarded-for': '1.2.3.4, 5.6.7.8' } });
    expect(clientIp(req)).toBe('1.2.3.4');
  });
  it('falls back to "unknown"', () => {
    expect(clientIp(new Request('http://x'))).toBe('unknown');
  });
});

describe('enforceLimit', () => {
  it('throws 429 when not allowed, passes when allowed', () => {
    expect(() => enforceLimit({ allowed: true, retryAfterMs: 0 })).not.toThrow();
    try {
      enforceLimit({ allowed: false, retryAfterMs: 100 });
      throw new Error('should have thrown');
    } catch (e) {
      expect(e).toBeInstanceOf(HttpError);
      expect((e as HttpError).status).toBe(429);
    }
  });
});

describe('errorResponse — user content never reaches the logs (US-8.3)', () => {
  it('strips bound query parameters out of a failed-query error', async () => {
    const logged: unknown[] = [];
    const spy = vi.spyOn(console, 'error').mockImplementation((...args) => {
      logged.push(...args);
    });

    // The shape drizzle throws: the values appear BOTH in `params` and
    // interpolated into `message`. For messaging those values are the text of
    // a private conversation, and logs are a separate store that GDPR
    // redaction cannot reach.
    const SECRET = 'CONFIDENTIAL-RATE-40000-GBP';
    const err = Object.assign(
      new Error(`Failed query: insert into "messages" ... params: some-uuid,${SECRET}`),
      {
        query: 'insert into "messages" ("body") values ($1)',
        params: ['some-uuid', SECRET],
        cause: Object.assign(new Error('null value violates not-null constraint'), {
          code: '23502',
        }),
      },
    );

    const res = errorResponse(err);
    expect(res.status).toBe(500);
    const dump = JSON.stringify(logged);
    expect(dump).not.toContain(SECRET);
    // …but it still says enough to debug: the SQL template and the driver error.
    expect(dump).toContain('insert into');
    expect(dump).toContain('23502');
    spy.mockRestore();
  });

  it('leaves an ordinary error alone', async () => {
    const logged: unknown[] = [];
    const spy = vi.spyOn(console, 'error').mockImplementation((...args) => {
      logged.push(...args);
    });
    errorResponse(new Error('something ordinary broke'));
    expect(JSON.stringify(logged.map(String))).toContain('something ordinary broke');
    spy.mockRestore();
  });
});
