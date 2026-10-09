'use client';

import { useState } from 'react';

// US-7.3 — completing a project is the moment it gains a result, so the outcome
// story is part of the action rather than an optional field added afterwards.
export default function CompleteProjectForm({ projectId }: { projectId: string }) {
  const [open, setOpen] = useState(false);
  const [story, setStory] = useState('');
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState('');

  const tooShort = story.trim().length < 30;

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    setBusy(true);
    setMsg('');
    try {
      const res = await fetch(`/api/projects/${projectId}/complete`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ outcomeStory: story.trim() }),
      });
      if (res.status === 401) {
        setMsg('Sign in to continue.');
        setBusy(false);
        return;
      }
      if (!res.ok) {
        const data = (await res.json().catch(() => null)) as { message?: string } | null;
        setMsg(data?.message ?? 'Could not complete the project. Please try again.');
        setBusy(false);
        return;
      }
      window.location.reload();
    } catch {
      setMsg('Could not reach HodorHub. Please try again.');
      setBusy(false);
    }
  }

  if (!open) {
    return (
      <div className="gift-actions">
        <button className="btn" onClick={() => setOpen(true)}>
          Mark complete
        </button>
      </div>
    );
  }

  return (
    <form className="gift-editor" onSubmit={submit}>
      <p className="detail-line">
        Tell supporters and the corporation what this project achieved. This is published on the
        project page and leads the preview when the link is shared.
      </p>
      <textarea
        rows={4}
        placeholder="What changed because of this project?"
        value={story}
        onChange={(e) => setStory(e.target.value)}
      />
      <div className="gift-editor-actions">
        <button type="submit" className="btn" disabled={busy || tooShort}>
          {busy ? 'Completing…' : 'Complete project'}
        </button>
        <button type="button" className="btn-ghost" onClick={() => setOpen(false)} disabled={busy}>
          Cancel
        </button>
      </div>
      {tooShort && story.length > 0 && (
        <p className="support-note">A little more detail — at least 30 characters.</p>
      )}
      {msg && <p className="support-note">{msg}</p>}
    </form>
  );
}
