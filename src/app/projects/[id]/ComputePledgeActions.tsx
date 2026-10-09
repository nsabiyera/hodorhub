'use client';

import { useState } from 'react';

async function post(path: string, body?: unknown): Promise<Response> {
  return fetch(path, {
    method: 'POST',
    headers: body ? { 'content-type': 'application/json' } : undefined,
    body: body ? JSON.stringify(body) : undefined,
  });
}

export default function ComputePledgeActions({
  pledgeId,
  status,
}: {
  pledgeId: string;
  status: string;
}) {
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState('');
  const [declining, setDeclining] = useState(false);
  const [reason, setReason] = useState('');

  async function act(path: string, body?: unknown) {
    setBusy(true);
    setMsg('');
    try {
      const res = await post(`/api/compute-pledges/${pledgeId}/${path}`, body);
      if (res.status === 401) {
        setMsg('Sign in to continue.');
        setBusy(false);
        return;
      }
      if (!res.ok) throw new Error();
      window.location.reload();
    } catch {
      setMsg('Could not complete that. Please try again.');
      setBusy(false);
    }
  }

  if (status !== 'proposed') return null;

  if (declining) {
    return (
      <div className="gift-reason">
        <input
          placeholder="Reason to decline"
          value={reason}
          onChange={(e) => setReason(e.target.value)}
        />
        <button
          className="btn"
          disabled={busy || !reason.trim()}
          onClick={() => act('decline', { reason: reason.trim() })}
        >
          Confirm decline
        </button>
        <button className="btn-ghost" onClick={() => setDeclining(false)} disabled={busy}>
          Cancel
        </button>
      </div>
    );
  }

  return (
    <div className="gift-actions">
      <button className="btn" disabled={busy} onClick={() => act('accept')}>
        Accept
      </button>
      <button className="btn-ghost" disabled={busy} onClick={() => setDeclining(true)}>
        Decline
      </button>
      {msg && <span className="support-note">{msg}</span>}
    </div>
  );
}
