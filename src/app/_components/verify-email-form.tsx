'use client';

import { useState } from 'react';

type Status = 'idle' | 'verifying' | 'done' | 'error';

/**
 * Confirms an email-verification token via POST /api/auth/verify-email.
 * We require an explicit click rather than verifying on load: the single-use
 * token is consumed by a POST, so email link-scanners (which issue GET
 * prefetches and don't run JS) can't silently burn it before the user arrives.
 */
export function VerifyEmailForm({ token }: { token: string | null }) {
  const [status, setStatus] = useState<Status>('idle');
  const [error, setError] = useState<string | null>(null);

  if (!token) {
    return (
      <div className="auth-done">
        <p className="about" style={{ marginTop: 8 }}>
          This confirmation link is missing its token. Open the most recent link from your email, or{' '}
          <a className="raven-signin" href="/register">
            register again
          </a>{' '}
          to receive a fresh one.
        </p>
      </div>
    );
  }

  if (status === 'done') {
    return (
      <div className="auth-done">
        <p className="about" style={{ marginTop: 8 }}>
          Your email is confirmed. Your organisation is still{' '}
          <strong>awaiting an admin review</strong> before you can publish — we&rsquo;ll send a
          raven when it&rsquo;s verified.
        </p>
        <a className="auth-submit auth-submit-link" href="/signin?next=/">
          Go to sign in
        </a>
      </div>
    );
  }

  async function confirm() {
    setError(null);
    setStatus('verifying');
    try {
      const res = await fetch('/api/auth/verify-email', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ token }),
      });
      if (res.ok) {
        setStatus('done');
        return;
      }
      const data = (await res.json().catch(() => null)) as { message?: string } | null;
      setError(
        data?.message ??
          'This link is invalid or has expired. Register again to receive a fresh one.',
      );
      setStatus('error');
    } catch {
      setError('Could not reach HodorHub. Check your connection and try again.');
      setStatus('error');
    }
  }

  return (
    <div className="auth-form">
      {error && (
        <p className="auth-error" role="alert">
          {error}
        </p>
      )}
      <button
        className="auth-submit"
        type="button"
        onClick={confirm}
        disabled={status === 'verifying'}
      >
        {status === 'verifying' ? 'Confirming…' : 'Confirm my email'}
      </button>
      {status === 'error' && (
        <p className="auth-alt">
          Need a new link? <a href="/register">Register again</a>.
        </p>
      )}
    </div>
  );
}
