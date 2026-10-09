'use client';

import { useState } from 'react';

/**
 * US-6.3 — the charity confirms a milestone. Offered whether or not every task
 * is ticked (real delivery does not always map to the board), but the prompt
 * says which of the two it is, so confirmation stays a deliberate act.
 */
export default function ConfirmMilestone({
  milestoneId,
  readyToConfirm,
}: {
  milestoneId: string;
  readyToConfirm: boolean;
}) {
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState('');

  async function confirm() {
    setBusy(true);
    setMsg('');
    try {
      const res = await fetch(`/api/milestones/${milestoneId}/achieve`, { method: 'POST' });
      if (!res.ok) throw new Error();
      window.location.reload();
    } catch {
      setMsg('Could not confirm that milestone. Please try again.');
      setBusy(false);
    }
  }

  return (
    <div className="gift-actions">
      <button className={readyToConfirm ? 'btn' : 'btn-ghost'} disabled={busy} onClick={confirm}>
        {readyToConfirm ? 'Confirm achieved' : 'Confirm achieved anyway'}
      </button>
      {msg && <span className="support-note">{msg}</span>}
    </div>
  );
}
