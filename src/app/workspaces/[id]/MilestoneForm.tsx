'use client';

import { useState } from 'react';

// US-6.3 — the charity draws the milestones. Only rendered for the charity
// owner; the route refuses anyone else.
export default function MilestoneForm({ workspaceId }: { workspaceId: string }) {
  const [open, setOpen] = useState(false);
  const [title, setTitle] = useState('');
  const [dueOn, setDueOn] = useState('');
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState('');

  async function submit() {
    setBusy(true);
    setMsg('');
    try {
      const res = await fetch(`/api/workspaces/${workspaceId}/milestones`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ title: title.trim(), ...(dueOn ? { dueOn } : {}) }),
      });
      if (!res.ok) throw new Error();
      window.location.reload();
    } catch {
      setMsg('Could not add that milestone. Please try again.');
      setBusy(false);
    }
  }

  if (!open) {
    return (
      <div className="gift-actions" style={{ marginTop: 20 }}>
        <button className="btn-ghost" onClick={() => setOpen(true)}>
          Add a milestone
        </button>
      </div>
    );
  }

  return (
    <div className="panel" style={{ marginTop: 20 }}>
      <h3>Add a milestone</h3>
      <p className="detail-line">
        A milestone is your statement of what &ldquo;delivered&rdquo; means. Only you can confirm
        one as achieved.
      </p>
      <input
        placeholder="What has to be true, e.g. “Volunteer rota published”"
        value={title}
        onChange={(e) => setTitle(e.target.value)}
      />
      <input type="date" value={dueOn} onChange={(e) => setDueOn(e.target.value)} />
      <div className="gift-actions">
        <button className="btn" disabled={busy || title.trim().length < 3} onClick={submit}>
          Add milestone
        </button>
        <button className="btn-ghost" disabled={busy} onClick={() => setOpen(false)}>
          Cancel
        </button>
        {msg && <span className="support-note">{msg}</span>}
      </div>
    </div>
  );
}
