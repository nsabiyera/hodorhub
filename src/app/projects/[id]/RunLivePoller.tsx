'use client';

import { useEffect } from 'react';
import { useRouter } from 'next/navigation';

const POLL_INTERVAL_MS = 4000;

// US-11.9 — while an agent-delivery run is still progressing, refresh the
// server component on an interval so the run panel advances without a manual
// reload. router.refresh() re-runs the force-dynamic page (re-fetching
// getRunForProject) and reconciles in place. Ticks are skipped while the tab
// is hidden; polling stops entirely once the run is no longer active.
export default function RunLivePoller({ active }: { active: boolean }) {
  const router = useRouter();

  useEffect(() => {
    if (!active) return;
    const id = setInterval(() => {
      if (typeof document !== 'undefined' && document.hidden) return;
      router.refresh();
    }, POLL_INTERVAL_MS);
    return () => clearInterval(id);
  }, [active, router]);

  if (!active) return null;
  return (
    <span className="run-live" aria-live="polite">
      ● Live — updating automatically
    </span>
  );
}
