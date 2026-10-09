'use client';

import { useState } from 'react';

type Mode = 'request-changes' | 'reject';

const MODE_LABEL: Record<Mode, string> = {
  'request-changes': 'Feedback',
  reject: 'Reason to reject',
};

const MODE_FIELD: Record<Mode, string> = {
  'request-changes': 'feedback',
  reject: 'reason',
};

async function post(path: string, body?: unknown): Promise<Response> {
  return fetch(path, {
    method: 'POST',
    headers: body ? { 'content-type': 'application/json' } : undefined,
    body: body ? JSON.stringify(body) : undefined,
  });
}

// US-11.3 — the charity's milestone gate: approve, request changes (with
// feedback), or reject (with a reason). Mirrors GiftActions' client conventions.
export default function MilestoneGateActions({ milestoneId }: { milestoneId: string }) {
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState('');
  const [mode, setMode] = useState<Mode | null>(null);
  const [text, setText] = useState('');

  async function act(path: string, body?: unknown) {
    setBusy(true);
    setMsg('');
    try {
      const res = await post(`/api/agent-milestones/${milestoneId}/${path}`, body);
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

  if (mode) {
    return (
      <div className="gift-reason">
        <input
          placeholder={MODE_LABEL[mode]}
          value={text}
          onChange={(e) => setText(e.target.value)}
        />
        <button
          className="btn"
          disabled={busy || !text.trim()}
          onClick={() => act(mode, { [MODE_FIELD[mode]]: text.trim() })}
        >
          Confirm {mode === 'request-changes' ? 'request changes' : 'reject'}
        </button>
        <button className="btn-ghost" onClick={() => setMode(null)} disabled={busy}>
          Cancel
        </button>
      </div>
    );
  }

  return (
    <div className="gift-actions">
      <button className="btn" disabled={busy} onClick={() => act('approve')}>
        Approve
      </button>
      <button className="btn-ghost" disabled={busy} onClick={() => setMode('request-changes')}>
        Request changes
      </button>
      <button className="btn-ghost" disabled={busy} onClick={() => setMode('reject')}>
        Reject
      </button>
      {msg && <span className="support-note">{msg}</span>}
    </div>
  );
}
