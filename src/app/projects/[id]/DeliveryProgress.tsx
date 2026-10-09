import Link from 'next/link';
import type { getDeliveryProgress } from '@/modules/delivery';

type Progress = Awaited<ReturnType<typeof getDeliveryProgress>>;

/**
 * US-6.4 — the charity owner's progress panel, plus the way into the shared
 * board (US-6.3) for whichever side is looking.
 *
 * The three effort figures stay three figures: allocated capacity is a plan,
 * pending hours are a claim, and only approved hours are delivered time
 * (US-6.2a). Nothing here adds them together into a single number.
 */
export default function DeliveryProgress({
  progress,
  workspaceId,
}: {
  progress: Progress | null;
  workspaceId: string | null;
}) {
  const link = workspaceId ? (
    <p className="detail-line">
      <Link className="btn" href={`/workspaces/${workspaceId}`}>
        Open the delivery workspace
      </Link>
    </p>
  ) : null;

  // Progress is the charity owner's read (US-6.4). Everyone else who belongs to
  // the workspace gets the way in and no progress claim either way — telling a
  // volunteer "nothing is in delivery" on a project they are delivering would
  // be worse than saying nothing.
  if (!progress) {
    return (
      <>
        <h3>Delivery</h3>
        {link}
      </>
    );
  }

  if (!progress.inDelivery) {
    return (
      <>
        <h3>Delivery</h3>
        <p className="detail-line">
          Nothing is in delivery on this project yet, so there is no progress to show.
        </p>
        {link}
      </>
    );
  }

  const { milestoneSummary: ms, unscheduledTasks: loose, effort } = progress;

  return (
    <>
      <h3>Delivery progress</h3>
      {progress.goal && (
        <p className="about">
          Against the goal: <strong>{progress.goal}</strong>
        </p>
      )}
      <div className="impact-grid">
        <div className="impact-stat">
          <div className="impact-value">
            {ms.achieved}/{ms.total}
          </div>
          <div className="detail-line">milestones confirmed</div>
        </div>
        <div className="impact-stat">
          <div className="impact-value">{ms.awaitingConfirmation}</div>
          <div className="detail-line">awaiting your confirmation</div>
        </div>
        <div className="impact-stat">
          <div className="impact-value">{ms.overdue}</div>
          <div className="detail-line">overdue</div>
        </div>
        <div className="impact-stat">
          <div className="impact-value">{effort.approvedHours}</div>
          <div className="detail-line">approved hours</div>
        </div>
      </div>
      <p className="detail-line">
        {effort.allocatedHoursPerWeek} hours/week allocated across {effort.volunteerCount} volunteer
        {effort.volunteerCount === 1 ? '' : 's'}
        {effort.pendingHours > 0 && (
          <>
            {' · '}
            <strong>{effort.pendingHours}</strong> hours logged but not yet approved, not counted
            above
          </>
        )}
      </p>
      {loose.todo + loose.inProgress + loose.done > 0 && (
        <p className="detail-line">
          {loose.todo + loose.inProgress + loose.done} task(s) sit under no milestone yet — shown
          apart so the milestone counts are not mistaken for all of the work.
        </p>
      )}
      {link}
    </>
  );
}
