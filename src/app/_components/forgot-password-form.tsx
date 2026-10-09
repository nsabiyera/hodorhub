'use client';

import { useState } from 'react';

/**
 * Requests a password-reset link. The endpoint always responds 200
 * (anti-enumeration), so the success copy is deliberately neutral — it never
 * reveals whether an account exists for the address.
 */
export function ForgotPasswordForm() {
  const [email, setEmail] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [pending, setPending] = useState(false);
  const [done, setDone] = useState(false);

  async function onSubmit(e: React.FormEvent) {
    e.preventDefault();
    setError(null);
    setPending(true);
    try {
      const res = await fetch('/api/auth/request-password-reset', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ email }),
      });
      if (res.ok) {
        setDone(true);
        return;
      }
      setError(
        res.status === 429
          ? 'Too many attempts. Wait a moment and try again.'
          : 'Could not send the reset link. Please try again.',
      );
    } catch {
      setError('Could not reach HodorHub. Check your connection and try again.');
    } finally {
      setPending(false);
    }
  }

  if (done) {
    return (
      <div className="auth-done">
        <p className="about" style={{ marginTop: 8 }}>
          If an account exists for <strong>{email}</strong>, a raven is on its way with a reset
          link. It expires in <strong>30 minutes</strong>.
        </p>
        <a className="auth-submit auth-submit-link" href="/signin">
          Back to sign in
        </a>
      </div>
    );
  }

  return (
    <form className="auth-form" onSubmit={onSubmit} noValidate>
      <label className="auth-field">
        <span>Email</span>
        <input
          type="email"
          autoComplete="email"
          required
          value={email}
          onChange={(e) => setEmail(e.target.value)}
        />
      </label>

      {error && (
        <p className="auth-error" role="alert">
          {error}
        </p>
      )}

      <button className="auth-submit" type="submit" disabled={pending}>
        {pending ? 'Sending…' : 'Send reset link'}
      </button>

      <p className="auth-alt">
        Remembered it? <a href="/signin">Sign in</a>.
      </p>
    </form>
  );
}
