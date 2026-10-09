import { NextResponse } from 'next/server';
import { ZodError } from 'zod';
import { DomainError } from '@/modules/identity/errors';

/** Generic HTTP-layer error (auth, method, etc.) with an explicit status. */
export class HttpError extends Error {
  constructor(
    readonly status: number,
    readonly code: string,
    message?: string,
  ) {
    super(message ?? code);
  }
}

const DOMAIN_STATUS: Record<string, number> = {
  email_in_use: 409,
  invalid_work_email: 422,
  not_found: 404,
  invalid_state: 409,
  invalid_credentials: 401,
  not_verified: 403,
  forbidden: 403,
  invalid_transition: 409,
  project_validation: 422,
  no_resource_needs: 422,
  // US-11.12 — well-formed request, but this project is not a shape the agents
  // are proven to deliver. 422, not 400: the body is valid.
  template_not_eligible: 422,
  // US-10.5 — the feature exists and you may use it; your plan does not include
  // it. 402, not 403: this is a billing answer, not a permission one.
  upgrade_required: 402,
  // US-10.7 — out of seats, not out of permission.
  seat_limit_reached: 402,
  // US-8.2 — a well-formed change to your own settings that the platform does
  // not allow: an essential notification cannot be silenced in-app.
  preference_locked: 422,
  // US-8.3 — you may see this project, but your organisation has no
  // relationship with it yet. A permission answer, not a missing resource:
  // 404 would hide an actionable prompt behind a lie.
  no_relationship: 403,
  // US-8.3 — a malformed pagination cursor is a bad request, never a 500.
  invalid_cursor: 400,
};

/** Map thrown errors to safe JSON responses; never leak internals on 500. */
export function errorResponse(e: unknown): NextResponse {
  if (e instanceof ZodError) {
    return NextResponse.json({ error: 'validation', details: e.flatten() }, { status: 400 });
  }
  if (e instanceof HttpError) {
    return NextResponse.json({ error: e.code, message: e.message }, { status: e.status });
  }
  if (e instanceof DomainError) {
    return NextResponse.json(
      { error: e.code, message: e.message },
      { status: DOMAIN_STATUS[e.code] ?? 400 },
    );
  }
  console.error('Unhandled route error', safeToLog(e));
  return NextResponse.json({ error: 'internal' }, { status: 500 });
}

/**
 * Strip user content out of an error before it reaches the logs.
 *
 * A failed query error carries the bound parameters — both in `params` and
 * interpolated into its own `message`. For most routes those are ids; for
 * US-8.3 they include the text of a private message between two
 * organisations. Logs are a separate store with their own retention and
 * access list, and GDPR redaction cannot reach them, so the values must not
 * arrive in the first place. The SQL template (placeholders only) and the
 * driver's own error are kept, which is what is actually diagnostic.
 */
function safeToLog(e: unknown): unknown {
  if (!(e instanceof Error)) return e;
  const withQuery = e as Error & { query?: unknown; params?: unknown; cause?: unknown };
  if (withQuery.params === undefined && withQuery.query === undefined) return e;
  const cause = withQuery.cause as
    { message?: string; code?: string; constraint?: string } | undefined;
  return {
    name: e.name,
    query: withQuery.query,
    // Deliberately NOT e.message: it embeds the parameter values.
    driverMessage: cause?.message,
    code: cause?.code,
    constraint: cause?.constraint,
    paramsOmitted: true,
  };
}

export async function readJson(req: Request): Promise<unknown> {
  try {
    return await req.json();
  } catch {
    throw new HttpError(400, 'invalid_json', 'Request body must be valid JSON.');
  }
}

/** Best-effort client IP for rate-limiting keys (behind Cloud Run / a proxy). */
export function clientIp(req: Request): string {
  const fwd = req.headers.get('x-forwarded-for');
  return fwd?.split(',')[0]?.trim() || 'unknown';
}

/** Throw a 429 when a per-instance rate limit is exceeded. */
export function enforceLimit(result: { allowed: boolean; retryAfterMs: number }): void {
  if (!result.allowed) {
    throw new HttpError(429, 'rate_limited', 'Too many requests. Please try again shortly.');
  }
}
