'use client';

import { useState } from 'react';

/**
 * Client sign-in form. POSTs to /api/auth/login, which sets the httpOnly
 * session cookie; on success we do a full navigation to `next` so the server
 * components re-read the fresh cookie.
 */
export function SignInForm({ next }: { next: string }) {
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [pending, setPending] = useState(false);

  async function onSubmit(e: React.FormEvent) {
    e.preventDefault();
    setError(null);
    setPending(true);
    try {
      const res = await fetch('/api/auth/login', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ email, password }),
      });
      if (res.ok) {
        window.location.assign(next);
        return;
      }
      const data = (await res.json().catch(() => null)) as { message?: string } | null;
      setError(
        res.status === 429
          ? 'Too many attempts. Wait a moment and try again.'
          : (data?.message ?? 'Could not sign you in. Please try again.'),
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
        <span>Email</span>
        <input
          type="email"
          name="email"
          autoComplete="email"
          required
          value={email}
          onChange={(e) => setEmail(e.target.value)}
        />
      </label>
      <label className="auth-field">
        <span>Password</span>
        <input
          type="password"
          name="password"
          autoComplete="current-password"
          required
          value={password}
          onChange={(e) => setPassword(e.target.value)}
        />
      </label>

      {error && (
        <p className="auth-error" role="alert">
          {error}
        </p>
      )}

      <button className="auth-submit" type="submit" disabled={pending}>
        {pending ? 'Opening the gate…' : 'Hold the door'}
      </button>

      <p className="auth-alt">
        <a href="/forgot-password">Forgot your password?</a>
      </p>
      <p className="auth-alt">
        New here? <a href="/register">Register your organisation</a>.
      </p>
    </form>
  );
}
