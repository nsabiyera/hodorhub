'use client';

import { useState } from 'react';

interface Option {
  code: string;
  label: string;
}

interface ProfileView {
  email: string;
  displayName: string | null;
  membership: {
    organisationName: string;
    weeklyHours: number | null;
    seniority: { code: string; label: string } | null;
    skills: { code: string; label: string }[];
    note: string | null;
    hasProfile: boolean;
  } | null;
}

/**
 * US-1.5 — the profile form.
 *
 * The display name is saved through its own endpoint so that a user with no
 * membership can still set one; skills and hours go through the profile
 * endpoint, which needs an organisation.
 */
export default function ProfileForm({
  profile,
  skills,
  seniorityLevels,
}: {
  profile: ProfileView;
  skills: Option[];
  seniorityLevels: Option[];
}) {
  const m = profile.membership;
  const [displayName, setDisplayName] = useState(profile.displayName ?? '');
  const [weeklyHours, setWeeklyHours] = useState(
    m?.weeklyHours === null || m?.weeklyHours === undefined ? '' : String(m.weeklyHours),
  );
  const [chosen, setChosen] = useState<string[]>((m?.skills ?? []).map((s) => s.code));
  const [seniority, setSeniority] = useState(m?.seniority?.code ?? '');
  const [note, setNote] = useState(m?.note ?? '');
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState('');

  function toggle(code: string) {
    setChosen((c) => (c.includes(code) ? c.filter((x) => x !== code) : [...c, code]));
  }

  async function saveName(e: React.FormEvent) {
    e.preventDefault();
    setBusy(true);
    setMsg('');
    try {
      const res = await fetch('/api/display-name', {
        method: 'PUT',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ displayName: displayName.trim() === '' ? null : displayName }),
      });
      if (!res.ok) {
        const b = (await res.json().catch(() => ({}))) as { message?: string };
        setMsg(b.message ?? 'Could not save that name.');
        return;
      }
      window.location.reload();
    } finally {
      setBusy(false);
    }
  }

  async function saveProfile(e: React.FormEvent) {
    e.preventDefault();
    // `Number('')` is 0 — which would silently turn "I typed nothing" into "I
    // offer none", the exact conflation this whole slice keeps apart. Guarded
    // here rather than relying on the input's `required` attribute alone.
    if (weeklyHours.trim() === '') {
      setMsg(
        'Enter the hours you can offer. 0 is a valid answer, and it means something different from leaving this blank.',
      );
      return;
    }
    setBusy(true);
    setMsg('');
    try {
      const res = await fetch('/api/profile', {
        method: 'PUT',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          weeklyHours: Number(weeklyHours),
          skills: chosen,
          seniority: seniority === '' ? null : seniority,
          note: note.trim() === '' ? null : note,
        }),
      });
      if (!res.ok) {
        const b = (await res.json().catch(() => ({}))) as { message?: string };
        setMsg(
          b.message ?? 'Could not save that. Choose at least one skill and a number of hours.',
        );
        return;
      }
      window.location.reload();
    } finally {
      setBusy(false);
    }
  }

  async function removeProfile() {
    setBusy(true);
    setMsg('');
    try {
      await fetch('/api/profile', { method: 'DELETE' });
      window.location.reload();
    } finally {
      setBusy(false);
    }
  }

  return (
    <>
      <form className="panel" style={{ marginTop: 20 }} onSubmit={saveName}>
        <h3>Your name</h3>
        <p className="detail-line">
          Shown instead of <strong>{profile.email}</strong> wherever you are named to someone else.
          Leave it empty to go back to your email address.
        </p>
        <input
          value={displayName}
          onChange={(e) => setDisplayName(e.target.value)}
          maxLength={80}
          placeholder="How you want to be known"
          disabled={busy}
        />
        <button type="submit" disabled={busy}>
          Save name
        </button>
      </form>

      {m === null ? (
        <p className="about" style={{ marginTop: 20 }}>
          You are not part of an organisation yet, so there are no hours to offer. Your name above
          still applies.
        </p>
      ) : (
        <form className="panel" style={{ marginTop: 20 }} onSubmit={saveProfile}>
          <h3>What you can offer {m.organisationName}</h3>
          <p className="detail-line">
            Only {m.organisationName}&apos;s administrators see this — never the charity you deliver
            for, and never your colleagues.
          </p>

          <label>
            Hours a week you can offer
            <input
              type="number"
              min={0}
              max={168}
              value={weeklyHours}
              onChange={(e) => setWeeklyHours(e.target.value)}
              disabled={busy}
              required
            />
          </label>
          <p className="detail-line">
            0 is a real answer — it means you are offering none right now, which is different from
            not saying.
          </p>

          <fieldset style={{ marginTop: 12 }}>
            <legend>Skills (choose at least one)</legend>
            <div className="gift-actions" style={{ flexWrap: 'wrap' }}>
              {skills.map((s) => (
                <label key={s.code} style={{ marginRight: 12 }}>
                  <input
                    type="checkbox"
                    checked={chosen.includes(s.code)}
                    onChange={() => toggle(s.code)}
                    disabled={busy}
                  />{' '}
                  {s.label}
                </label>
              ))}
            </div>
          </fieldset>

          <label style={{ display: 'block', marginTop: 12 }}>
            Seniority (optional)
            <select
              value={seniority}
              onChange={(e) => setSeniority(e.target.value)}
              disabled={busy}
            >
              <option value="">Prefer not to say</option>
              {seniorityLevels.map((s) => (
                <option key={s.code} value={s.code}>
                  {s.label}
                </option>
              ))}
            </select>
          </label>

          <label style={{ display: 'block', marginTop: 12 }}>
            Anything else (optional)
            <textarea
              value={note}
              onChange={(e) => setNote(e.target.value)}
              rows={3}
              maxLength={500}
              placeholder="Context your manager might need — not used for matching."
              disabled={busy}
              style={{ width: '100%' }}
            />
          </label>

          <button type="submit" disabled={busy || chosen.length === 0}>
            {busy ? 'Saving…' : 'Save'}
          </button>
          {m.hasProfile && (
            <button type="button" onClick={removeProfile} disabled={busy}>
              Delete what I have shared
            </button>
          )}
          {m.hasProfile && (
            <p className="detail-line">
              Deleting returns you to <em>no stated availability</em>. Your allocations and logged
              hours are your employer&apos;s record and stay exactly as they are.
            </p>
          )}
        </form>
      )}
      {msg && <p className="support-note">{msg}</p>}
    </>
  );
}
