'use client';

import { useState } from 'react';

// US-6.3 — either coordinator adds a task. The assignee list is the volunteers
// allocated to THIS workspace (US-6.1), which is also what the domain enforces.
export default function AddTaskForm({
  workspaceId,
  milestones,
  allocations,
}: {
  workspaceId: string;
  milestones: { id: string; title: string }[];
  allocations: { id: string; label: string }[];
}) {
  const [open, setOpen] = useState(false);
  const [title, setTitle] = useState('');
  const [detail, setDetail] = useState('');
  const [milestoneId, setMilestoneId] = useState('');
  const [assignedAllocationId, setAssignedAllocationId] = useState('');
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState('');

  async function submit() {
    setBusy(true);
    setMsg('');
    try {
      const res = await fetch(`/api/workspaces/${workspaceId}/tasks`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          title: title.trim(),
          ...(detail.trim() ? { detail: detail.trim() } : {}),
          ...(milestoneId ? { milestoneId } : {}),
          ...(assignedAllocationId ? { assignedAllocationId } : {}),
        }),
      });
      if (!res.ok) throw new Error();
      window.location.reload();
    } catch {
      setMsg('Could not add that task. Please try again.');
      setBusy(false);
    }
  }

  if (!open) {
    return (
      <div className="gift-actions" style={{ marginTop: 20 }}>
        <button className="btn-ghost" onClick={() => setOpen(true)}>
          Add a task
        </button>
      </div>
    );
  }

  return (
    <div className="panel" style={{ marginTop: 20 }}>
      <h3>Add a task</h3>
      <input
        placeholder="What needs doing"
        value={title}
        onChange={(e) => setTitle(e.target.value)}
      />
      <textarea
        placeholder="Any detail the other side needs (optional)"
        value={detail}
        onChange={(e) => setDetail(e.target.value)}
      />
      <select value={milestoneId} onChange={(e) => setMilestoneId(e.target.value)}>
        <option value="">No milestone yet</option>
        {milestones.map((m) => (
          <option key={m.id} value={m.id}>
            {m.title}
          </option>
        ))}
      </select>
      <select
        value={assignedAllocationId}
        onChange={(e) => setAssignedAllocationId(e.target.value)}
      >
        <option value="">Unassigned</option>
        {allocations.map((a) => (
          <option key={a.id} value={a.id}>
            {a.label}
          </option>
        ))}
      </select>
      <div className="gift-actions">
        <button className="btn" disabled={busy || title.trim().length < 3} onClick={submit}>
          Add task
        </button>
        <button className="btn-ghost" disabled={busy} onClick={() => setOpen(false)}>
          Cancel
        </button>
        {msg && <span className="support-note">{msg}</span>}
      </div>
    </div>
  );
}
