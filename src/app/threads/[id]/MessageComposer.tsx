'use client';

import { useState } from 'react';

/**
 * US-8.3 — the composer. Posts to the project + corporation pair rather than a
 * thread id, because that pair is the thread's identity and it is the single
 * write path the rate limit guards.
 */
export default function MessageComposer({
  projectId,
  corporationOrgId,
}: {
  projectId: string;
  corporationOrgId: string;
}) {
  const [body, setBody] = useState('');
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState('');

  async function send(e: React.FormEvent) {
    e.preventDefault();
    if (!body.trim()) return;
    setBusy(true);
    setMsg('');
    try {
      const res = await fetch(`/api/projects/${projectId}/messages`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ corporationOrgId, body }),
      });
      if (!res.ok) {
        const parsed = (await res.json().catch(() => ({}))) as { message?: string };
        setMsg(
          parsed.message ??
            (res.status === 429
              ? 'You are sending messages too quickly. Give it a moment.'
              : 'Could not send that. Please try again.'),
        );
        return;
      }
      setBody('');
      window.location.reload();
    } catch {
      setMsg('Could not send that. Please try again.');
    } finally {
      setBusy(false);
    }
  }

  return (
    <form className="panel" style={{ marginTop: 20 }} onSubmit={send}>
      <h3>Reply</h3>
      <textarea
        value={body}
        onChange={(e) => setBody(e.target.value)}
        rows={4}
        maxLength={4000}
        placeholder="Write a message…"
        style={{ width: '100%' }}
        disabled={busy}
      />
      <button type="submit" disabled={busy || !body.trim()}>
        {busy ? 'Sending…' : 'Send'}
      </button>
      {msg && <p className="support-note">{msg}</p>}
    </form>
  );
}
