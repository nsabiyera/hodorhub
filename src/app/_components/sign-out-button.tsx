'use client';

import { useState } from 'react';

/** Clears the session cookie via /api/auth/logout, then reloads at home. */
export function SignOutButton() {
  const [pending, setPending] = useState(false);
  return (
    <button
      type="button"
      className="nav-signout"
      disabled={pending}
      onClick={async () => {
        setPending(true);
        await fetch('/api/auth/logout', { method: 'POST' }).catch(() => {});
        window.location.assign('/');
      }}
    >
      Sign out
    </button>
  );
}
