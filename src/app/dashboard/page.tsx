import { redirect } from 'next/navigation';
import Link from 'next/link';
import type { Metadata } from 'next';
import { getSession } from '@/lib/auth';
import { getUserOrg } from '@/modules/identity';
import { getCorporateImpact } from '@/modules/reporting';
import {
  hasEntitlement,
  getEntitlementSummary,
  FEATURES,
  lowestPlanWith,
} from '@/modules/monetisation';

export const dynamic = 'force-dynamic';

export const metadata: Metadata = {
  title: 'CSR dashboard — HodorHub',
  description: 'Your social impact across every project you have supported.',
};

const STATUS_LABEL: Record<string, string> = {
  published: 'Open for support',
  in_delivery: 'In delivery',
  completed: 'Completed',
  archived: 'Archived',
  draft: 'Draft',
};

const pounds = (minor: number) => `£${(minor / 100).toFixed(2)}`;

// US-7.1 — the CSR manager's cross-project impact, for internal and external
// reporting. Donated time and agent delivery are deliberately two sections in
// two different units: hours cannot be bought, and compute spend is not an
// hours-equivalent.
export default async function DashboardPage() {
  const session = await getSession();
  if (!session) redirect('/signin');
  const org = await getUserOrg(session.userId);
  if (!org || org.orgType !== 'corporation' || org.role !== 'csr_manager') redirect('/');

  // US-10.5 — a locked feature explains itself and offers the upgrade, rather
  // than 404ing or vanishing from the nav. The domain gate is the real
  // enforcement; this is the human-facing half of it.
  if (!(await hasEntitlement(org.organisationId, FEATURES.csrDashboard))) {
    const summary = await getEntitlementSummary(org.organisationId);
    const required = lowestPlanWith(FEATURES.csrDashboard);
    return (
      <section className="detail">
        <div className="wrap">
          <h1>CSR dashboard</h1>
          <div className="panel" style={{ marginTop: 20 }}>
            <h3>Available on {required?.name ?? 'a paid plan'}</h3>
            <p className="about">
              The CSR dashboard totals your donated hours, the projects you have supported and their
              outcomes, ready for internal and external reporting.
            </p>
            <p className="detail-line">
              You are on <strong>{summary.planName}</strong>. Everything in the core loop stays free
              — finding projects, pledging, and delivering are never gated.
            </p>
            <div className="gift-actions">
              <Link className="btn" href="/billing">
                See {required?.name ?? 'paid'} plans
              </Link>
            </div>
          </div>
        </div>
      </section>
    );
  }

  const impact = await getCorporateImpact(session.userId, org.organisationId);

  return (
    <section className="detail">
      <div className="wrap">
        <h1>CSR dashboard</h1>
        <p className="detail-line">
          Your social impact across every project you have supported. Figures are all-time.
        </p>

        <div className="panel" style={{ marginTop: 20 }}>
          <h3>Donated time</h3>
          <div className="impact-grid">
            <div className="impact-stat">
              <div className="impact-value">{impact.hours.approvedHours}</div>
              <div className="detail-line">approved hours</div>
            </div>
            <div className="impact-stat">
              <div className="impact-value">{impact.projectsSupported}</div>
              <div className="detail-line">projects supported</div>
            </div>
            <div className="impact-stat">
              <div className="impact-value">{impact.hours.volunteerCount}</div>
              <div className="detail-line">volunteers</div>
            </div>
            <div className="impact-stat">
              <div className="impact-value">{impact.gifts.receivedCount}</div>
              <div className="detail-line">gifts received</div>
            </div>
          </div>
          {impact.hours.pendingHours > 0 && (
            <p className="detail-line">
              <strong>{impact.hours.pendingHours}</strong> hours logged but not yet approved — not
              counted above.
            </p>
          )}
          {(impact.gifts.awaitingConfirmationCount > 0 || impact.gifts.promisedCount > 0) && (
            <p className="detail-line">
              {impact.gifts.awaitingConfirmationCount} gift(s) awaiting charity confirmation ·{' '}
              {impact.gifts.promisedCount} still promised
            </p>
          )}
        </div>

        {impact.agentDelivery.runCount > 0 && (
          <div className="panel" style={{ marginTop: 20 }}>
            <h3>Agent-delivered projects</h3>
            <p className="detail-line">
              Reported separately from donated time, in its own units — agent delivery is a parallel
              path to volunteering, not a substitute for it.
            </p>
            <div className="impact-grid">
              <div className="impact-stat">
                <div className="impact-value">{impact.agentDelivery.completedRunCount}</div>
                <div className="detail-line">completed of {impact.agentDelivery.runCount} runs</div>
              </div>
              <div className="impact-stat">
                <div className="impact-value">{pounds(impact.agentDelivery.consumedMinor)}</div>
                <div className="detail-line">
                  compute spent of {pounds(impact.agentDelivery.committedMinor)} committed
                </div>
              </div>
            </div>
          </div>
        )}

        <div className="panel" style={{ marginTop: 20 }}>
          <h3>Outcomes</h3>
          {impact.outcomes.length === 0 ? (
            <p className="detail-line">
              No projects have completed yet. Outcome stories appear here as charities publish them.
            </p>
          ) : (
            impact.outcomes.map((o) => (
              <div className="gift-row" key={o.projectId}>
                <div className="gift-main">
                  <div className="role">
                    <Link href={`/projects/${o.projectId}`}>{o.title}</Link>
                  </div>
                  <p className="about">{o.outcomeStory}</p>
                </div>
              </div>
            ))
          )}
        </div>

        {impact.projects.length > 0 && (
          <div className="panel" style={{ marginTop: 20 }}>
            <h3>Projects supported</h3>
            {impact.projects.map((p) => (
              <div className="gift-row" key={p.projectId}>
                <div className="gift-main">
                  <div className="role">
                    <Link href={`/projects/${p.projectId}`}>{p.title}</Link>
                  </div>
                </div>
                <span className="gift-chip">{STATUS_LABEL[p.status] ?? p.status}</span>
              </div>
            ))}
          </div>
        )}
      </div>
    </section>
  );
}
