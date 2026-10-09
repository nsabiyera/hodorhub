'use client';

import { useState } from 'react';

const KINDS = [
  'cloud_credits',
  'api_budget',
  'llm_budget',
  'saas_seats',
  'hosting',
  'domains',
  'other',
] as const;
type Kind = (typeof KINDS)[number];
const LABEL: Record<Kind, string> = {
  cloud_credits: 'Cloud credits',
  api_budget: 'API budget',
  llm_budget: 'LLM budget',
  saas_seats: 'SaaS seats',
  hosting: 'Hosting',
  domains: 'Domains',
  other: 'Other',
};

export default function OfferGiftForm({
  projectId,
  corporationOrgId,
  needs,
}: {
  projectId: string;
  corporationOrgId: string;
  needs: { id: string; kind: string; description?: string | null }[];
}) {
  const [kind, setKind] = useState<Kind>('cloud_credits');
  const [needId, setNeedId] = useState('');
  const [quantity, setQuantity] = useState('');
  const [unit, setUnit] = useState('');
  const [note, setNote] = useState('');
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState('');

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    setBusy(true);
    setMsg('');
    const body = {
      corporationOrgId,
      kind,
      ...(needId ? { needId } : {}),
      ...(quantity.trim() ? { quantity: Number(quantity) } : {}),
      ...(unit.trim() ? { unit: unit.trim() } : {}),
      ...(note.trim() ? { note: note.trim() } : {}),
    };
    try {
      const res = await fetch(`/api/projects/${projectId}/resource-gifts`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(body),
      });
      if (res.status === 401) {
        setMsg('Sign in to offer a gift.');
        setBusy(false);
        return;
      }
      if (!res.ok) {
        const data = (await res.json().catch(() => null)) as { message?: string } | null;
        setMsg(data?.message ?? 'Could not submit the offer. Please try again.');
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
      <div className="gift-editor-row" style={{ gridTemplateColumns: '1.2fr 0.7fr 0.9fr 1.6fr' }}>
        <select value={kind} onChange={(e) => setKind(e.target.value as Kind)}>
          {KINDS.map((k) => (
            <option key={k} value={k}>
              {LABEL[k]}
            </option>
          ))}
        </select>
        <input
          placeholder="quantity"
          inputMode="numeric"
          value={quantity}
          onChange={(e) => setQuantity(e.target.value)}
        />
        <input
          placeholder="unit (e.g. USD credits)"
          value={unit}
          onChange={(e) => setUnit(e.target.value)}
        />
        <input
          placeholder="note (optional)"
          value={note}
          onChange={(e) => setNote(e.target.value)}
        />
      </div>
      {needs.length > 0 && (
        <select value={needId} onChange={(e) => setNeedId(e.target.value)}>
          <option value="">Toward the project generally</option>
          {needs.map((n) => (
            <option key={n.id} value={n.id}>
              Toward:{' '}
              {LABEL[(KINDS as readonly string[]).includes(n.kind) ? (n.kind as Kind) : 'other']}
              {n.description ? ` — ${n.description}` : ''}
            </option>
          ))}
        </select>
      )}
      <div className="gift-editor-actions">
        <button type="submit" className="btn" disabled={busy}>
          {busy ? 'Offering…' : 'Offer resource gift'}
        </button>
      </div>
      {msg && <p className="support-note">{msg}</p>}
    </form>
  );
}
