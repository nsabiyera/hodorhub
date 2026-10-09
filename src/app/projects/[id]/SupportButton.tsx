'use client';

import { useState } from 'react';

export default function SupportButton({ projectId }: { projectId: string }) {
  const [state, setState] = useState<'idle' | 'busy' | 'done'>('idle');
  const [msg, setMsg] = useState('');

  async function holdTheDoor() {
    setState('busy');
    try {
      const res = await fetch(`/api/projects/${projectId}/support`, { method: 'POST' });
      if (res.status === 401) {
        setMsg('Sign in to hold the door for this project.');
        setState('idle');
        return;
      }
      if (!res.ok) throw new Error();
      setMsg('Thanks for holding the door.');
      setState('done');
    } catch {
      setMsg('Something went wrong. Please try again.');
      setState('idle');
    }
  }

  return (
    <>
      <button className="btn" onClick={holdTheDoor} disabled={state !== 'idle'}>
        {state === 'done' ? 'Door held' : state === 'busy' ? 'Holding…' : 'Hold the door'}
      </button>
      {msg && <p className="support-note">{msg}</p>}
    </>
  );
}
