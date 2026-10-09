'use client';

import { useState } from 'react';

// US-10.6 — start a checkout or cancel. Subscribing redirects to the payment
// provider; nothing changes here until the provider calls back, so the button
// deliberately does not optimistically show the new plan.
export default function SubscribeActions({
  organisationId,
  planCode,
  isCurrent,
  hasActiveSubscription,
}: {
  organisationId: string;
  planCode: string;
  isCurrent: boolean;
  hasActiveSubscription: boolean;
}) {
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState('');

  async function subscribe() {
    setBusy(true);
    setMsg('');
    try {
      const res = await fetch(`/api/organisations/${organisationId}/subscription`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ planCode }),
      });
      const data = (await res.json().catch(() => null)) as {
        url?: string;
        message?: string;
      } | null;
      if (!res.ok || !data?.url) {
        setMsg(data?.message ?? 'Could not start checkout. Please try again.');
        setBusy(false);
        return;
      }
      window.location.href = data.url;
    } catch {
      setMsg('Could not reach the payment provider. Please try again.');
      setBusy(false);
    }
  }

  async function cancel() {
    setBusy(true);
    setMsg('');
    try {
      const res = await fetch(`/api/organisations/${organisationId}/subscription`, {
        method: 'DELETE',
      });
      if (!res.ok) throw new Error();
      window.location.reload();
    } catch {
      setMsg('Could not cancel. Please try again.');
      setBusy(false);
    }
  }

  if (isCurrent) {
    return hasActiveSubscription ? (
      <div className="gift-actions">
        <button className="btn-ghost" disabled={busy} onClick={cancel}>
          Cancel subscription
        </button>
        {msg && <span className="support-note">{msg}</span>}
      </div>
    ) : null;
  }

  return (
    <div className="gift-actions">
      <button className="btn" disabled={busy} onClick={subscribe}>
        {busy ? 'Starting…' : 'Choose this plan'}
      </button>
      {msg && <span className="support-note">{msg}</span>}
    </div>
  );
}
