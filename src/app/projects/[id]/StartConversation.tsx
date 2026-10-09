'use client';

import { useState } from 'react';

/**
 * US-8.3 — the first message on a thread that does not exist yet.
 *
 * There is no "create thread" call: the thread row is written inside the same
 * transaction as this first message, so an empty conversation — a row asserting
 * a conversation nobody has had — cannot exist. On success we navigate to the
 * thread the server just created.
 */
export default function StartConversation({
  projectId,
  corporationOrgId,
}: {
  projectId: string;
  corporationOrgId: string;
}) {
  const [open, setOpen] = useState(false);
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
      const parsed = (await res.json().catch(() => ({}))) as {
        threadId?: string;
        message?: string;
      };
      if (!res.ok || !parsed.threadId) {
        setMsg(parsed.message ?? 'Could not start that conversation. Please try again.');
        return;
      }
      window.location.href = `/threads/${parsed.threadId}`;
    } catch {
      setMsg('Could not start that conversation. Please try again.');
    } finally {
      setBusy(false);
    }
  }

  if (!open) {
    return (
      <button type="button" onClick={() => setOpen(true)}>
        Start the conversation
      </button>
    );
  }

  return (
    <form onSubmit={send}>
      <textarea
        value={body}
        onChange={(e) => setBody(e.target.value)}
        rows={3}
        maxLength={4000}
        placeholder="Write the first message…"
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
