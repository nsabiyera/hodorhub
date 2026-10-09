'use client';

import { useState } from 'react';

type Role = 'charity' | 'corporation';

/**
 * Client registration form. A charity or a company registers their
 * organisation; both endpoints create the org in `pending` state and send a
 * verification email, so on success we show a "check your email" state rather
 * than signing the user in (they can't publish until an admin verifies them).
 */
export function RegisterForm() {
  const [role, setRole] = useState<Role>('charity');
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [orgName, setOrgName] = useState(''); // charityName | companyName
  const [regNumber, setRegNumber] = useState(''); // charity only
  const [emailDomain, setEmailDomain] = useState(''); // corporation only
  const [error, setError] = useState<string | null>(null);
  const [pending, setPending] = useState(false);
  const [done, setDone] = useState(false);

  function switchRole(next: Role) {
    setRole(next);
    setError(null);
  }

  async function onSubmit(e: React.FormEvent) {
    e.preventDefault();
    setError(null);
    setPending(true);
    try {
      const endpoint = `/api/register/${role}`;
      const body =
        role === 'charity'
          ? { email, password, charityName: orgName, regNumber }
          : { email, password, companyName: orgName, emailDomain };
      const res = await fetch(endpoint, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(body),
      });
      if (res.status === 201) {
        setDone(true);
        return;
      }
      const data = (await res.json().catch(() => null)) as { message?: string } | null;
      setError(
        res.status === 429
          ? 'Too many attempts. Wait a moment and try again.'
          : (data?.message ?? 'Could not complete registration. Please check your details.'),
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
          Your {role === 'charity' ? 'charity' : 'company'} is registered and{' '}
          <strong>awaiting verification</strong>. We&rsquo;ve sent a raven to{' '}
          <strong>{email}</strong> — confirm your email, and an admin will review your organisation
          before you can publish.
        </p>
        <a className="auth-submit auth-submit-link" href="/signin?next=/">
          Go to sign in
        </a>
      </div>
    );
  }

  return (
    <form className="auth-form" onSubmit={onSubmit} noValidate>
      <div className="auth-toggle" role="tablist" aria-label="Register as">
        <button
          type="button"
          role="tab"
          aria-selected={role === 'charity'}
          onClick={() => switchRole('charity')}
        >
          A charity
        </button>
        <button
          type="button"
          role="tab"
          aria-selected={role === 'corporation'}
          onClick={() => switchRole('corporation')}
        >
          A company
        </button>
      </div>

      <label className="auth-field">
        <span>{role === 'charity' ? 'Charity name' : 'Company name'}</span>
        <input
          type="text"
          required
          minLength={2}
          maxLength={200}
          value={orgName}
          onChange={(e) => setOrgName(e.target.value)}
        />
      </label>

      {role === 'charity' ? (
        <label className="auth-field">
          <span>Charity registration number</span>
          <input
            type="text"
            required
            maxLength={50}
            value={regNumber}
            onChange={(e) => setRegNumber(e.target.value)}
          />
        </label>
      ) : (
        <label className="auth-field">
          <span>Work email domain</span>
          <input
            type="text"
            required
            placeholder="acme.com"
            value={emailDomain}
            onChange={(e) => setEmailDomain(e.target.value)}
          />
          <span className="auth-hint">Your email below must be on this domain.</span>
        </label>
      )}

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
      <label className="auth-field">
        <span>Password</span>
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

      {error && (
        <p className="auth-error" role="alert">
          {error}
        </p>
      )}

      <button className="auth-submit" type="submit" disabled={pending}>
        {pending ? 'Taking the oath…' : 'Take the oath'}
      </button>

      <p className="auth-alt">
        Already sworn in? <a href="/signin">Sign in</a>.
      </p>
    </form>
  );
}
