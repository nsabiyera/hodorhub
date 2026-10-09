'use client';

import { useState } from 'react';

// US-11.8 — the charity owner's separate, explicit approval to go live. It is
// deliberately a second, confirmed step rather than a one-click action beside
// the milestone gate: approving the delivery phase means "this is good", not
// "put it in front of the public".
export default function PromoteToProduction({ runId }: { runId: string }) {
  const [busy, setBusy] = useState(false);
  const [confirming, setConfirming] = useState(false);
  const [msg, setMsg] = useState('');

  async function promote() {
    setBusy(true);
    setMsg('');
    try {
      const res = await fetch(`/api/runs/${runId}/promote`, { method: 'POST' });
      if (res.status === 401) {
        setMsg('Sign in to continue.');
        setBusy(false);
        return;
      }
      if (res.status === 409) {
        setMsg('This app has already been promoted.');
        setBusy(false);
        return;
      }
      if (!res.ok) throw new Error();
      window.location.reload();
    } catch {
      setMsg('Could not start the promotion. Please try again.');
      setBusy(false);
    }
  }

  if (confirming) {
    return (
      <div className="gift-reason">
        <span className="detail-line">
          Promote this app to production? It becomes publicly live.
        </span>
        <button className="btn" disabled={busy} onClick={promote}>
          Yes, go live
        </button>
        <button className="btn-ghost" disabled={busy} onClick={() => setConfirming(false)}>
          Cancel
        </button>
        {msg && <span className="support-note">{msg}</span>}
      </div>
    );
  }

  return (
    <div className="gift-actions">
      <button className="btn" disabled={busy} onClick={() => setConfirming(true)}>
        Promote to production
      </button>
      {msg && <span className="support-note">{msg}</span>}
    </div>
  );
}
