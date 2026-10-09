'use client';

import { useState, type ReactNode } from 'react';

type Perspective = 'charity' | 'corp';

async function post(path: string, body?: unknown): Promise<Response> {
  return fetch(path, {
    method: 'POST',
    headers: body ? { 'content-type': 'application/json' } : undefined,
    body: body ? JSON.stringify(body) : undefined,
  });
}

export default function GiftActions({
  giftId,
  status,
  perspective,
}: {
  giftId: string;
  status: string;
  perspective: Perspective;
}) {
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState('');
  const [reasonFor, setReasonFor] = useState<'decline' | 'withdraw' | null>(null);
  const [reason, setReason] = useState('');

  async function act(path: string, body?: unknown) {
    setBusy(true);
    setMsg('');
    try {
      const res = await post(`/api/resource-gifts/${giftId}/${path}`, body);
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

  if (reasonFor) {
    return (
      <div className="gift-reason">
        <input
          placeholder={`Reason to ${reasonFor}`}
          value={reason}
          onChange={(e) => setReason(e.target.value)}
        />
        <button
          className="btn"
          disabled={busy || !reason.trim()}
          onClick={() => act(reasonFor, { reason: reason.trim() })}
        >
          Confirm {reasonFor}
        </button>
        <button className="btn-ghost" onClick={() => setReasonFor(null)} disabled={busy}>
          Cancel
        </button>
      </div>
    );
  }

  const buttons: ReactNode[] = [];
  if (perspective === 'charity') {
    if (status === 'offered') {
      buttons.push(
        <button key="a" className="btn" disabled={busy} onClick={() => act('accept')}>
          Accept
        </button>,
        <button
          key="d"
          className="btn-ghost"
          disabled={busy}
          onClick={() => setReasonFor('decline')}
        >
          Decline
        </button>,
      );
    } else if (status === 'provided') {
      buttons.push(
        <button key="r" className="btn" disabled={busy} onClick={() => act('received')}>
          Confirm received
        </button>,
      );
    }
  } else {
    if (status === 'accepted') {
      buttons.push(
        <button key="p" className="btn" disabled={busy} onClick={() => act('provided')}>
          Mark provided
        </button>,
      );
    }
    if (status === 'offered' || status === 'accepted' || status === 'provided') {
      buttons.push(
        <button
          key="w"
          className="btn-ghost"
          disabled={busy}
          onClick={() => setReasonFor('withdraw')}
        >
          Withdraw
        </button>,
      );
    }
  }

  if (buttons.length === 0 && !msg) return null;
  return (
    <div className="gift-actions">
      {buttons}
      {msg && <span className="support-note">{msg}</span>}
    </div>
  );
}
