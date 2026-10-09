'use client';

import { useState } from 'react';

// US-11.12 — the options come from the server, computed from the eligible
// template registry for THIS project's category. The form never invents a
// template code, so a corporation is not offered something the funding gate
// would reject at 422.
export type TemplateOption = { code: string; label: string };

export default function FundAgentDeliveryForm({
  projectId,
  corporationOrgId,
  templates,
}: {
  projectId: string;
  corporationOrgId: string;
  templates: readonly TemplateOption[];
}) {
  const [templateCode, setTemplateCode] = useState<string>(templates[0]?.code ?? '');
  const [budget, setBudget] = useState('');
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState('');

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    const pounds = Number(budget);
    if (!Number.isFinite(pounds) || pounds <= 0) {
      setMsg('Enter a budget greater than £0.');
      return;
    }
    const budgetMinor = Math.round(pounds * 100);
    setBusy(true);
    setMsg('');
    try {
      const res = await fetch(`/api/projects/${projectId}/compute-pledges`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ corporationOrgId, templateCode, budgetMinor }),
      });
      if (res.status === 401) {
        setMsg('Sign in to continue.');
        setBusy(false);
        return;
      }
      if (!res.ok) {
        const data = (await res.json().catch(() => null)) as { message?: string } | null;
        setMsg(data?.message ?? 'Could not submit the pledge. Please try again.');
        setBusy(false);
        return;
      }
      window.location.reload();
    } catch {
      setMsg('Could not reach HodorHub. Please try again.');
      setBusy(false);
    }
  }

  return (
    <form className="gift-editor" onSubmit={submit}>
      <div className="gift-editor-row" style={{ gridTemplateColumns: '1.2fr 0.8fr' }}>
        <select value={templateCode} onChange={(e) => setTemplateCode(e.target.value)}>
          {templates.map((t) => (
            <option key={t.code} value={t.code}>
              {t.label}
            </option>
          ))}
        </select>
        <input
          placeholder="budget (£)"
          inputMode="decimal"
          value={budget}
          onChange={(e) => setBudget(e.target.value)}
        />
      </div>
      <div className="gift-editor-actions">
        <button type="submit" className="btn" disabled={busy}>
          {busy ? 'Funding…' : 'Fund agent delivery'}
        </button>
      </div>
      {msg && <p className="support-note">{msg}</p>}
    </form>
  );
}
