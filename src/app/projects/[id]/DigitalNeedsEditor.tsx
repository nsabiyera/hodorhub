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

interface Row {
  kind: Kind;
  description: string;
  quantity: string;
  unit: string;
}
type InitialNeed = {
  kind: string;
  description?: string | null;
  quantity?: number | null;
  unit?: string | null;
};

export default function DigitalNeedsEditor({
  projectId,
  initialNeeds,
}: {
  projectId: string;
  initialNeeds: InitialNeed[];
}) {
  const [rows, setRows] = useState<Row[]>(
    initialNeeds.map((n) => ({
      kind: (KINDS as readonly string[]).includes(n.kind) ? (n.kind as Kind) : 'other',
      description: n.description ?? '',
      quantity: n.quantity !== null && n.quantity !== undefined ? String(n.quantity) : '',
      unit: n.unit ?? '',
    })),
  );
  const [state, setState] = useState<'idle' | 'busy'>('idle');
  const [msg, setMsg] = useState('');

  function update(i: number, patch: Partial<Row>) {
    setRows((rs) => rs.map((r, idx) => (idx === i ? { ...r, ...patch } : r)));
  }
  function addRow() {
    setRows((rs) => [...rs, { kind: 'cloud_credits', description: '', quantity: '', unit: '' }]);
  }
  function removeRow(i: number) {
    setRows((rs) => rs.filter((_, idx) => idx !== i));
  }

  async function save() {
    setState('busy');
    setMsg('');
    const needs = rows.map((r) => ({
      kind: r.kind,
      ...(r.description.trim() ? { description: r.description.trim() } : {}),
      ...(r.quantity.trim() ? { quantity: Number(r.quantity) } : {}),
      ...(r.unit.trim() ? { unit: r.unit.trim() } : {}),
    }));
    try {
      const res = await fetch(`/api/projects/${projectId}/digital-resource-needs`, {
        method: 'PUT',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ needs }),
      });
      if (res.status === 401) {
        setMsg('Sign in to edit this project.');
        setState('idle');
        return;
      }
      if (!res.ok) throw new Error();
      window.location.reload();
    } catch {
      setMsg('Could not save. Please try again.');
      setState('idle');
    }
  }

  return (
    <div className="gift-editor">
      {rows.length === 0 && <p className="about">No digital resources requested yet.</p>}
      {rows.map((r, i) => (
        <div className="gift-editor-row" key={i}>
          <select value={r.kind} onChange={(e) => update(i, { kind: e.target.value as Kind })}>
            {KINDS.map((k) => (
              <option key={k} value={k}>
                {LABEL[k]}
              </option>
            ))}
          </select>
          <input
            placeholder="quantity"
            inputMode="numeric"
            value={r.quantity}
            onChange={(e) => update(i, { quantity: e.target.value })}
          />
          <input
            placeholder="unit (e.g. seats)"
            value={r.unit}
            onChange={(e) => update(i, { unit: e.target.value })}
          />
          <input
            placeholder="description"
            value={r.description}
            onChange={(e) => update(i, { description: e.target.value })}
          />
          <button type="button" className="gift-x" onClick={() => removeRow(i)} aria-label="Remove">
            ×
          </button>
        </div>
      ))}
      <div className="gift-editor-actions">
        <button type="button" className="btn-ghost" onClick={addRow}>
          + Add resource
        </button>
        <button type="button" className="btn" onClick={save} disabled={state === 'busy'}>
          {state === 'busy' ? 'Saving…' : 'Save resources needed'}
        </button>
      </div>
      {msg && <p className="support-note">{msg}</p>}
    </div>
  );
}
