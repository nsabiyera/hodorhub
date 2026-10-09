'use client';

import { useState } from 'react';

/**
 * Sets a new password from a reset token. Mirrors the server rule (min 10) and
 * checks the confirmation matches before posting. On success the user signs in
 * with the new password — we don't auto-create a session from a reset.
 */
export function ResetPasswordForm({ token }: { token: string | null }) {
  const [password, setPassword] = useState('');
  const [confirm, setConfirm] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [pending, setPending] = useState(false);
  const [done, setDone] = useState(false);

  if (!token) {
    return (
      <div className="auth-done">
        <p className="about" style={{ marginTop: 8 }}>
          This reset link is missing its token. Reset links expire after 30 minutes —{' '}
          <a className="raven-signin" href="/forgot-password">
            request a fresh one
          </a>
          .
        </p>
      </div>
    );
  }

  if (done) {
    return (
      <div className="auth-done">
        <p className="about" style={{ marginTop: 8 }}>
          Your password has been reset. You can sign in with it now.
        </p>
        <a className="auth-submit auth-submit-link" href="/signin?next=/">
          Go to sign in
        </a>
      </div>
    );
  }

  async function onSubmit(e: React.FormEvent) {
    e.preventDefault();
    setError(null);
    if (password.length < 10) {
      setError('Your password must be at least 10 characters.');
      return;
    }
    if (password !== confirm) {
      setError('Those passwords don’t match.');
      return;
    }
    setPending(true);
    try {
      const res = await fetch('/api/auth/reset-password', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ token, password }),
      });
      if (res.ok) {
        setDone(true);
        return;
      }
      const data = (await res.json().catch(() => null)) as { message?: string } | null;
      setError(
        res.status === 400
          ? 'Your password must be at least 10 characters.'
          : (data?.message ??
              'This reset link is invalid or has expired. Request a fresh one to try again.'),
      );
    } catch {
      setError('Could not reach HodorHub. Check your connection and try again.');
    } finally {
      setPending(false);
    }
  }

  return (
    <form className="auth-form" onSubmit={onSubmit} noValidate>
      <label className="auth-field">
        <span>New password</span>
        <input
          type="password"
          autoComplete="new-password"
          required
          minLength={10}
          value={password}
          onChange={(e) => setPassword(e.target.value)}
        />
        <span className="auth-hint">At least 10 characters.</span>
      </label>
      <label className="auth-field">
        <span>Confirm new password</span>
        <input
          type="password"
          autoComplete="new-password"
          required
          minLength={10}
          value={confirm}
          onChange={(e) => setConfirm(e.target.value)}
        />
      </label>

      {error && (
        <p className="auth-error" role="alert">
          {error}
        </p>
      )}

      <button className="auth-submit" type="submit" disabled={pending}>
        {pending ? 'Resetting…' : 'Set new password'}
      </button>
    </form>
  );
}
