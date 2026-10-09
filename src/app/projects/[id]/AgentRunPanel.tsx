import type { getRunForProject } from '@/modules/agent-delivery';
import MilestoneGateActions from './MilestoneGateActions';
import { isRunActive } from '@/modules/agent-delivery';
import RunLivePoller from './RunLivePoller';
import PromoteToProduction from './PromoteToProduction';

type RunDetail = NonNullable<Awaited<ReturnType<typeof getRunForProject>>>;

const PHASES = ['requirements', 'design', 'build', 'delivery'] as const;

const RUN_STATUS_LABEL: Record<string, string> = {
  authorized: 'Authorized',
  running: 'Running',
  awaiting_gate: 'Awaiting review',
  paused: 'Paused',
  halted: 'Halted',
  completed: 'Completed',
  failed: 'Failed',
};

const PHASE_LABEL: Record<string, string> = {
  requirements: 'Requirements',
  design: 'Design',
  build: 'Build',
  delivery: 'Delivery',
};

const MILESTONE_STATUS_LABEL: Record<string, string> = {
  pending: 'Pending',
  awaiting_review: 'Awaiting review',
  approved: 'Approved',
  changes_requested: 'Changes requested',
  rejected: 'Rejected',
};

function truncate(text: string | null | undefined, max = 140): string | null {
  if (!text) return null;
  return text.length > max ? `${text.slice(0, max)}…` : text;
}

// US-11.3/11.4/11.9 — run status + a 4-row phase timeline, the budget line, the
// deployed staging URL once live, and (for the reviewing charity owner) the
// milestone gate actions at whichever phase is awaiting review. US-11.8 adds
// the production line: the live URL, an in-flight promotion, or the separate
// approval to go live.
export default function AgentRunPanel({
  run,
  milestones,
  budget,
  staging,
  production,
  canReview,
}: RunDetail & { canReview: boolean }) {
  const deliveryApproved = milestones.find((m) => m.phase === 'delivery')?.status === 'approved';
  const stagingLive = staging?.status === 'live' && !!staging.url;
  // A failed promotion is not a blocker — approving again is how you retry.
  const promotionOpen = production?.status === 'deploying' || production?.status === 'live';
  const canPromote = canReview && deliveryApproved && stagingLive && !promotionOpen;
  return (
    <>
      <h3>Agent delivery run</h3>
      <div className="run-status">
        <span className={`gift-chip gift-chip-run-${run.status}`}>
          {RUN_STATUS_LABEL[run.status] ?? run.status}
        </span>
        <span className="detail-line">
          Current phase: {PHASE_LABEL[run.currentPhase] ?? run.currentPhase}
        </span>
        <RunLivePoller active={isRunActive(run.status)} />
      </div>

      <div className="phase-timeline">
        {PHASES.map((phase) => {
          const milestone = milestones.find((m) => m.phase === phase);
          const status = milestone?.status ?? 'pending';
          const preview = truncate(milestone?.artifactRef);
          return (
            <div className="phase-row" key={phase}>
              <span className={`phase-dot phase-dot-${status}`} />
              <div className="phase-main">
                <div className="role">{PHASE_LABEL[phase]}</div>
                {preview && <div className="detail-line">{preview}</div>}
              </div>
              <span className="gift-chip">{MILESTONE_STATUS_LABEL[status] ?? status}</span>
              {canReview && milestone && status === 'awaiting_review' && (
                <MilestoneGateActions milestoneId={milestone.id} />
              )}
            </div>
          );
        })}
      </div>

      <div className="run-budget">
        Budget: £{(budget.committedMinor / 100).toFixed(2)} committed · £
        {(budget.consumedMinor / 100).toFixed(2)} consumed · £
        {(budget.remainingMinor / 100).toFixed(2)} remaining
      </div>

      {stagingLive && (
        <div className="run-deploy">
          Deployed to staging:{' '}
          <a href={staging!.url!} target="_blank" rel="noopener noreferrer">
            {staging!.url}
          </a>
        </div>
      )}

      {production?.status === 'live' && production.url && (
        <div className="run-deploy">
          Live in production:{' '}
          <a href={production.url} target="_blank" rel="noopener noreferrer">
            {production.url}
          </a>
        </div>
      )}
      {production?.status === 'deploying' && (
        <div className="run-deploy">Promoting to production…</div>
      )}
      {production?.status === 'failed' && (
        <div className="run-deploy">
          The last promotion to production failed. You can approve it again.
        </div>
      )}
      {canPromote && <PromoteToProduction runId={run.id} />}
    </>
  );
}
