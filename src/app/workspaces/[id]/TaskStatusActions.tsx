'use client';

import { useState } from 'react';

const NEXT: Record<string, { status: string; label: string }[]> = {
  todo: [{ status: 'in_progress', label: 'Start' }],
  in_progress: [
    { status: 'done', label: 'Mark done' },
    { status: 'todo', label: 'Back to to-do' },
  ],
  done: [{ status: 'in_progress', label: 'Reopen' }],
};

// US-6.3 — move a task. Rendered only for a coordinator or the task's own
// assignee; the domain refuses anyone else regardless.
export default function TaskStatusActions({ taskId, status }: { taskId: string; status: string }) {
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState('');

  async function move(next: string) {
    setBusy(true);
    setMsg('');
    try {
      const res = await fetch(`/api/tasks/${taskId}`, {
        method: 'PATCH',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ status: next }),
      });
      if (res.status === 401) {
        setMsg('Sign in to continue.');
        setBusy(false);
        return;
      }
      if (!res.ok) throw new Error();
      window.location.reload();
    } catch {
      setMsg('Could not move that task. Please try again.');
      setBusy(false);
    }
  }

  return (
    <div className="gift-actions">
      {(NEXT[status] ?? []).map((n) => (
        <button key={n.status} className="btn-ghost" disabled={busy} onClick={() => move(n.status)}>
          {n.label}
        </button>
      ))}
      {msg && <span className="support-note">{msg}</span>}
    </div>
  );
}
