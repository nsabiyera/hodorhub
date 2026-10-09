import type { Metadata } from 'next';
import { notFound, redirect } from 'next/navigation';
import { getSession } from '@/lib/auth';
import { getUserOrg, NotFoundError, ForbiddenError } from '@/modules/identity';
import { getVolunteerRoster } from '@/modules/reporting';

export const dynamic = 'force-dynamic';

export const metadata: Metadata = {
  title: 'Your team — HodorHub',
  description: 'Who is on your team, what they can do, and how much they are carrying.',
};

/**
 * US-1.5 — the roster an administrator allocates from.
 *
 * Two figures are deliberately kept apart: what someone *offered* and what they
 * are *carrying*. A member who has said nothing shows "not stated", never 0 —
 * the platform does not turn "nobody said" into a number.
 */
export default async function TeamPage() {
  const session = await getSession();
  if (!session) redirect('/signin?next=/team');

  const org = await getUserOrg(session.userId);
  if (!org) notFound();

  let roster;
  try {
    roster = await getVolunteerRoster(session.userId, org.organisationId);
  } catch (e) {
    if (e instanceof NotFoundError || e instanceof ForbiddenError) notFound();
    throw e;
  }

  return (
    <section className="detail">
      <div className="wrap">
        <a className="back" href="/">
          &larr; All projects
        </a>
        <span className="eyebrow" style={{ display: 'block', marginTop: 18 }}>
          Your team
        </span>
        <h1>Who can help</h1>
        <p className="about">
          What each person offered, and what they are already carrying across your live projects.
          None of this is ever visible to the charities you deliver for.
        </p>

        <div className="panel" style={{ marginTop: 20 }}>
          {roster.entries.length === 0 ? (
            <p className="about">Nobody has been invited yet.</p>
          ) : (
            roster.entries.map((e) => (
              <div className="gift-row" key={e.userId}>
                <div className="gift-main">
                  <div className="role">
                    {e.label}{' '}
                    <span className="detail-line">
                      {e.role.replace('_', ' ')}
                      {e.displayName && e.email ? ` · ${e.email}` : ''}
                    </span>
                  </div>
                  {e.hasProfile ? (
                    <>
                      <p className="about">
                        {e.skills.map((s) => s.label).join(' · ') || 'No skills listed'}
                        {e.seniority ? ` — ${e.seniority.label}` : ''}
                      </p>
                      {e.note && <p className="detail-line">{e.note}</p>}
                    </>
                  ) : (
                    <p className="detail-line">
                      No stated availability — they have not filled anything in.
                    </p>
                  )}
                </div>
                <div className="gift-actions">
                  <div className="detail-line">
                    Offered:{' '}
                    <strong>
                      {e.weeklyHours === null ? 'not stated' : `${e.weeklyHours} h/week`}
                    </strong>
                  </div>
                  <div className="detail-line">
                    Allocated: <strong>{e.allocatedHoursPerWeek} h/week</strong>
                  </div>
                  {e.overAllocated === true && (
                    <p className="support-note">
                      Over by {e.overBy} h/week. That is allowed — they have been told.
                    </p>
                  )}
                </div>
              </div>
            ))
          )}
        </div>
      </div>
    </section>
  );
}
