import type { Metadata } from 'next';
import Link from 'next/link';
import { notFound, redirect } from 'next/navigation';
import { getSession } from '@/lib/auth';
import { getWorkspaceBoard } from '@/modules/delivery';
import { NotFoundError } from '@/modules/identity';
import { listConversationsForProject } from '@/modules/messaging';
import TaskStatusActions from './TaskStatusActions';
import AddTaskForm from './AddTaskForm';
import MilestoneForm from './MilestoneForm';
import ConfirmMilestone from './ConfirmMilestone';

export const dynamic = 'force-dynamic';

export const metadata: Metadata = {
  title: 'Delivery workspace — HodorHub',
  description: 'The shared board where a charity and its delivery partner run the work.',
};

const TASK_LABEL: Record<string, string> = {
  todo: 'To do',
  in_progress: 'In progress',
  done: 'Done',
};

/**
 * US-6.3 / US-6.4 — the shared delivery board. Both organisations see the same
 * board; the actions rendered come from `viewer`, so the page never offers a
 * button the domain would refuse. Milestone confirmation is the charity's alone.
 */
export default async function WorkspacePage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const session = await getSession();
  if (!session) redirect('/signin');

  let board;
  try {
    board = await getWorkspaceBoard(session.userId, id);
  } catch (e) {
    if (e instanceof NotFoundError) notFound();
    throw e;
  }

  const { viewer, milestones, tasks, allocations, effort, project, corporationOrgId } = board;
  // US-8.3 — the conversation for this board's corporation, if it has started.
  // This is the messaging US-6.3 deferred. One link, never a second rendering
  // of the thread: the thread page is the only place a conversation is drawn.
  const conversations = await listConversationsForProject(session.userId, project.id);
  const conversation = conversations.find((c) => c.corporationOrgId === corporationOrgId);
  const allocationLabel = new Map(allocations.map((a) => [a.id, a.label]));
  const looseTasks = tasks.filter((t) => t.milestoneId === null);

  function taskRow(t: (typeof tasks)[number]) {
    const canMove = viewer.canManageTasks || viewer.allocationIds.includes(t.assignedAllocationId!);
    return (
      <div className="gift-row" key={t.id}>
        <div className="gift-main">
          <div className="role">{t.title}</div>
          {t.detail && <p className="about">{t.detail}</p>}
          <p className="detail-line">
            {t.assignedAllocationId
              ? `Assigned to ${allocationLabel.get(t.assignedAllocationId) ?? 'a volunteer'}`
              : 'Unassigned'}
          </p>
        </div>
        <span className="gift-chip">{TASK_LABEL[t.status]}</span>
        {canMove && <TaskStatusActions taskId={t.id} status={t.status} />}
      </div>
    );
  }

  return (
    <section className="detail">
      <div className="wrap">
        <p className="detail-line">
          <Link href={`/projects/${project.id}`}>{project.title}</Link> ·{' '}
          {viewer.side === 'charity' ? 'your project' : 'you are delivering this'}
        </p>
        <h1>Delivery workspace</h1>

        {conversation?.threadId && (
          <p className="detail-line">
            <Link href={`/threads/${conversation.threadId}`}>
              Open the conversation with {conversation.corporationName} &rarr;
            </Link>
          </p>
        )}

        {project.goal && (
          <div className="panel" style={{ marginTop: 20 }}>
            <h3>The goal</h3>
            <p className="about">{project.goal}</p>
            <p className="detail-line">
              Everything below is progress against this (US-6.4). The charity sets the milestones;
              the delivery partner moves the tasks.
            </p>
          </div>
        )}

        {/* Three figures, deliberately never one. Allocated capacity is a plan,
            pending hours are a claim, and only approved hours are delivered. */}
        <div className="panel" style={{ marginTop: 20 }}>
          <h3>Effort</h3>
          <div className="impact-grid">
            <div className="impact-stat">
              <div className="impact-value">{effort.allocatedHoursPerWeek}</div>
              <div className="detail-line">hours/week allocated</div>
            </div>
            <div className="impact-stat">
              <div className="impact-value">{effort.approvedHours}</div>
              <div className="detail-line">approved hours</div>
            </div>
            <div className="impact-stat">
              <div className="impact-value">{effort.pendingHours}</div>
              <div className="detail-line">hours awaiting approval</div>
            </div>
            <div className="impact-stat">
              <div className="impact-value">{effort.volunteerCount}</div>
              <div className="detail-line">volunteers</div>
            </div>
          </div>
          <p className="detail-line">
            Approved and pending hours are kept apart and never added together — only approved hours
            are delivered time (US-6.2a).
          </p>
        </div>

        {viewer.canManageMilestones && <MilestoneForm workspaceId={id} />}

        {milestones.length === 0 ? (
          <div className="panel" style={{ marginTop: 20 }}>
            <h3>No milestones yet</h3>
            <p className="detail-line">
              {viewer.canManageMilestones
                ? 'Add the milestones that define what "delivered" means for this project.'
                : 'The charity has not set any milestones yet.'}
            </p>
          </div>
        ) : (
          milestones.map((m) => {
            const mine = tasks.filter((t) => t.milestoneId === m.id);
            return (
              <div className="panel" style={{ marginTop: 20 }} key={m.id}>
                <h3>{m.title}</h3>
                <p className="detail-line">
                  {m.status === 'achieved' ? (
                    <span className="gift-chip">Achieved</span>
                  ) : m.readyToConfirm ? (
                    <span className="gift-chip">All tasks done — awaiting the charity</span>
                  ) : (
                    <span className="gift-chip">Open</span>
                  )}
                  {m.dueOn && (
                    <>
                      {' · '}due {m.dueOn}
                      {m.overdue && <strong> · overdue</strong>}
                    </>
                  )}
                  {' · '}
                  {m.taskCounts.done}/{mine.length} tasks done
                </p>
                {m.status === 'open' && viewer.canManageMilestones && (
                  <ConfirmMilestone milestoneId={m.id} readyToConfirm={m.readyToConfirm} />
                )}
                {mine.length === 0 ? (
                  <p className="detail-line">No tasks under this milestone yet.</p>
                ) : (
                  mine.map(taskRow)
                )}
              </div>
            );
          })
        )}

        {looseTasks.length > 0 && (
          <div className="panel" style={{ marginTop: 20 }}>
            <h3>Not under a milestone</h3>
            <p className="detail-line">
              Shown separately so the milestone counts are never mistaken for all of the work.
            </p>
            {looseTasks.map(taskRow)}
          </div>
        )}

        {viewer.canManageTasks && (
          <AddTaskForm
            workspaceId={id}
            milestones={milestones
              .filter((m) => m.status === 'open')
              .map((m) => ({ id: m.id, title: m.title }))}
            allocations={allocations.map((a) => ({ id: a.id, label: a.label }))}
          />
        )}
      </div>
    </section>
  );
}
