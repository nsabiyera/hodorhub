'use client';

import { useState } from 'react';

interface KindView {
  code: string;
  label: string;
  description: string;
  essential: boolean;
  inApp: boolean;
  email: boolean;
}

/**
 * US-8.2 — the preferences panel. An essential kind's in-app switch is shown
 * as locked rather than hidden, so it is obvious *why* it cannot be turned off
 * instead of the control mysteriously not being there. The domain refuses it
 * either way.
 */
export default function PreferenceToggles({ initial }: { initial: KindView[] }) {
  const [kinds, setKinds] = useState(initial);
  const [busy, setBusy] = useState<string | null>(null);
  const [msg, setMsg] = useState('');

  async function change(kind: KindView, patch: Partial<Pick<KindView, 'inApp' | 'email'>>) {
    setBusy(kind.code);
    setMsg('');
    try {
      const res = await fetch('/api/notification-preferences', {
        method: 'PUT',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          kind: kind.code,
          inApp: patch.inApp ?? kind.inApp,
          email: patch.email ?? kind.email,
        }),
      });
      const body = (await res.json()) as { kinds?: KindView[]; message?: string };
      if (!res.ok) {
        setMsg(body.message ?? 'Could not save that. Please try again.');
        return;
      }
      if (body.kinds) setKinds(body.kinds);
    } catch {
      setMsg('Could not save that. Please try again.');
    } finally {
      setBusy(null);
    }
  }

  return (
    <div className="panel" style={{ marginTop: 20 }}>
      <h3>What reaches you</h3>
      <p className="detail-line">
        Choose what you hear about and how. The two channels are separate: switch <em>In-app</em>{' '}
        off and nothing is written for you at all — a silenced message never waits unread — while{' '}
        <em>Email</em> still reaches you if you leave it on.
      </p>
      {kinds.map((k) => (
        <div className="gift-row" key={k.code}>
          <div className="gift-main">
            <div className="role">{k.label}</div>
            <p className="about">{k.description}</p>
            {k.essential && (
              <p className="detail-line">
                Always arrives in-app — it carries decisions only you can make.
              </p>
            )}
          </div>
          <div className="gift-actions">
            <label>
              <input
                type="checkbox"
                checked={k.inApp}
                disabled={k.essential || busy === k.code}
                onChange={(e) => change(k, { inApp: e.target.checked })}
              />{' '}
              In-app
            </label>
            <label>
              <input
                type="checkbox"
                checked={k.email}
                disabled={busy === k.code}
                onChange={(e) => change(k, { email: e.target.checked })}
              />{' '}
              Email
            </label>
          </div>
        </div>
      ))}
      {msg && <p className="support-note">{msg}</p>}
    </div>
  );
}
