import type { ProjectImpact } from '@/modules/reporting';

// US-7.2 — the charity owner's impact summary: what this project gathered and
// what it received. The approved/pending and received/promised splits are shown
// rather than summed, because the whole value of this panel to a trustee report
// is that it never overstates what was actually delivered.
export default function ImpactSummary({ impact }: { impact: ProjectImpact }) {
  const { support, hours, gifts, agentDelivery, project } = impact;

  return (
    <>
      <h3>Impact summary</h3>
      <p className="detail-line">For your trustee and funder reporting.</p>

      <div className="impact-grid">
        <div className="impact-stat">
          <div className="impact-value">{support.supporterCount}</div>
          <div className="detail-line">supporters</div>
        </div>
        <div className="impact-stat">
          <div className="impact-value">{support.supportScore}</div>
          <div className="detail-line">support score</div>
        </div>
        <div className="impact-stat">
          <div className="impact-value">{hours.approvedHours}</div>
          <div className="detail-line">approved hours</div>
        </div>
        <div className="impact-stat">
          <div className="impact-value">{gifts.receivedCount}</div>
          <div className="detail-line">gifts received</div>
        </div>
      </div>

      {(hours.pendingHours > 0 || hours.volunteerCount > 0) && (
        <p className="detail-line">
          {hours.volunteerCount} volunteer{hours.volunteerCount === 1 ? '' : 's'} allocated
          {hours.pendingHours > 0 && (
            <>
              {' · '}
              <strong>{hours.pendingHours}</strong> hours awaiting employer approval, not counted
              above
            </>
          )}
        </p>
      )}

      {(gifts.awaitingConfirmationCount > 0 || gifts.promisedCount > 0) && (
        <p className="detail-line">
          {gifts.awaitingConfirmationCount > 0 && (
            <>
              {gifts.awaitingConfirmationCount} gift(s) marked provided, awaiting your confirmation
            </>
          )}
          {gifts.awaitingConfirmationCount > 0 && gifts.promisedCount > 0 && ' · '}
          {gifts.promisedCount > 0 && <>{gifts.promisedCount} still promised</>}
        </p>
      )}

      {agentDelivery && (
        <div className="run-deploy" style={{ marginTop: 12 }}>
          <strong>Agent-delivered</strong> — {agentDelivery.milestonesApproved} of{' '}
          {agentDelivery.milestoneCount} milestones approved ({agentDelivery.status})
          {agentDelivery.productionUrl && (
            <>
              {' · '}
              <a href={agentDelivery.productionUrl} target="_blank" rel="noopener noreferrer">
                live app
              </a>
            </>
          )}
          <div className="detail-line">
            Reported separately from donated volunteer hours, and never counted as public support.
          </div>
        </div>
      )}

      {project.outcomeStory && (
        <div style={{ marginTop: 12 }}>
          <strong>Outcome</strong>
          <p className="about">{project.outcomeStory}</p>
        </div>
      )}
    </>
  );
}
