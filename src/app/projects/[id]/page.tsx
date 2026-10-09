import type { Metadata } from 'next';
import { notFound } from 'next/navigation';
import { getPublishedProject } from '@/modules/projects';
import { getSupportInfo } from '@/modules/engagement';
import { getScore } from '@/modules/scoring';
import { getSession } from '@/lib/auth';
import { findMembership, getUserOrg } from '@/modules/identity';
import {
  listResourceGiftsForProject,
  listResourceGiftsForCorp,
  listComputePledgesForProject,
  listComputePledgesForCorp,
} from '@/modules/commitments';
import {
  getRunForProject,
  AGENT_DELIVERY_TEMPLATES,
  eligibleTemplatesFor,
} from '@/modules/agent-delivery';
import SupportButton from './SupportButton';
import DigitalNeedsEditor from './DigitalNeedsEditor';
import GiftActions from './GiftActions';
import OfferGiftForm from './OfferGiftForm';
import ComputePledgeActions from './ComputePledgeActions';
import FundAgentDeliveryForm from './FundAgentDeliveryForm';
import AgentRunPanel from './AgentRunPanel';
import CompleteProjectForm from './CompleteProjectForm';
import ImpactSummary from './ImpactSummary';
import { getProjectImpact } from '@/modules/reporting';
import { findWorkspaceForParticipant, getDeliveryProgress } from '@/modules/delivery';
import DeliveryProgress from './DeliveryProgress';
import Conversations from './Conversations';

export const dynamic = 'force-dynamic';

const STATUS_LABEL: Record<string, string> = {
  published: 'Open for support',
  in_delivery: 'In delivery',
  completed: 'Completed',
};

const KIND_LABEL: Record<string, string> = {
  cloud_credits: 'Cloud credits',
  api_budget: 'API budget',
  llm_budget: 'LLM budget',
  saas_seats: 'SaaS seats',
  hosting: 'Hosting',
  domains: 'Domains',
  other: 'Other',
};

const GIFT_STATUS_LABEL: Record<string, string> = {
  offered: 'Offered',
  accepted: 'Accepted',
  declined: 'Declined',
  provided: 'Provided',
  received: 'Received',
  withdrawn: 'Withdrawn',
};

const PLEDGE_STATUS_LABEL: Record<string, string> = {
  proposed: 'Proposed',
  accepted: 'Accepted',
  declined: 'Declined',
};

// US-11.12 — labels come from the eligible-template registry, not a second copy.
const TEMPLATE_LABEL: Record<string, string> = Object.fromEntries(
  AGENT_DELIVERY_TEMPLATES.map((t) => [t.code, t.label]),
);

// US-3.1 — rich social preview cards for links shared on Facebook / X.
export async function generateMetadata({
  params,
}: {
  params: Promise<{ id: string }>;
}): Promise<Metadata> {
  const { id } = await params;
  const p = await getPublishedProject(id);
  if (!p) return { title: 'Project not found — HodorHub' };
  // US-7.3 — a completed project's card leads with what was achieved, not the
  // appeal it no longer needs. Truncated for card limits; the page shows it all.
  const outcome = p.status === 'completed' && p.outcomeStory ? p.outcomeStory : null;
  const description = outcome
    ? outcome.length > 200
      ? `${outcome.slice(0, 199)}…`
      : outcome
    : (p.goal ?? p.description ?? 'A charity project on HodorHub.');
  return {
    title: `${p.title} — HodorHub`,
    description,
    openGraph: { title: p.title, description, type: 'website' },
    twitter: { card: 'summary_large_image', title: p.title, description },
  };
}

export default async function ProjectPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const project = await getPublishedProject(id);
  if (!project) notFound();

  const [{ supportCount }, score] = await Promise.all([getSupportInfo(id, null), getScore(id)]);

  const session = await getSession();
  const membership = session ? await findMembership(session.userId, project.charityOrgId) : null;
  const isCharityOwner = membership?.role === 'charity_owner';
  const charityGifts =
    isCharityOwner && session ? await listResourceGiftsForProject(session.userId, id) : [];

  const userOrg = session ? await getUserOrg(session.userId) : null;
  const isCorpManager =
    !!userOrg &&
    userOrg.role === 'csr_manager' &&
    userOrg.orgType === 'corporation' &&
    userOrg.status === 'verified';
  const corpGifts =
    isCorpManager && session
      ? await listResourceGiftsForCorp(session.userId, id, userOrg!.organisationId)
      : [];

  const charityComputePledges =
    isCharityOwner && session ? await listComputePledgesForProject(session.userId, id) : [];
  const corpComputePledges =
    isCorpManager && session
      ? await listComputePledgesForCorp(session.userId, id, userOrg!.organisationId)
      : [];

  // US-6.3 — the shared delivery board, offered to whichever side is looking.
  const workspace = session ? await findWorkspaceForParticipant(session.userId, id) : null;
  // US-6.4 — progress against the goal is the charity owner's read.
  const progress = isCharityOwner && session ? await getDeliveryProgress(session.userId, id) : null;

  const runDetail = session ? await getRunForProject(id) : null;
  // US-7.2 — owner-only; getProjectImpact throws for anyone else, so it is only
  // requested when the viewer is the owning charity.
  const impact = isCharityOwner && session ? await getProjectImpact(session.userId, id) : null;
  // US-11.12 — which templates, if any, can deliver a project of this shape.
  const eligibleTemplates = eligibleTemplatesFor(project.category).map((t) => ({
    code: t.code,
    label: t.label,
  }));
  const canSeeRun =
    !!runDetail &&
    (isCharityOwner ||
      (isCorpManager && userOrg!.organisationId === runDetail.run.corporationOrgId));

  return (
    <section className="detail">
      <div className="wrap">
        <a className="back" href="/">
          &larr; All projects
        </a>
        <h1>{project.title}</h1>
        <div className="detail-by">
          <span className="verified">✓ Verified charity</span>
          <span>&middot;</span>
          <span>{STATUS_LABEL[project.status] ?? project.status}</span>
          {project.category && (
            <>
              <span>&middot;</span>
              <span>{project.category.charAt(0).toUpperCase() + project.category.slice(1)}</span>
            </>
          )}
        </div>

        <div className="detail-grid">
          <div>
            {project.status === 'completed' && project.outcomeStory && (
              <div className="panel" style={{ marginBottom: 20 }}>
                <h3>What this project achieved</h3>
                <p className="about">{project.outcomeStory}</p>
                {project.completedAt && (
                  <p className="detail-line">
                    Completed {new Date(project.completedAt).toLocaleDateString('en-GB')}
                  </p>
                )}
              </div>
            )}
            <div className="panel">
              <h3>The goal</h3>
              <p className="goal">{project.goal ?? 'This project is still being detailed.'}</p>
              {isCharityOwner && project.status === 'in_delivery' && (
                <div style={{ marginTop: 16 }}>
                  <CompleteProjectForm projectId={id} />
                </div>
              )}
            </div>
            <div className="panel" style={{ marginTop: 20 }}>
              <h3>About this project</h3>
              <p className="about">{project.description}</p>
            </div>
            <div className="panel" style={{ marginTop: 20 }}>
              <h3>Help needed</h3>
              {project.resourceNeeds.length === 0 ? (
                <p className="about">No specific roles listed yet.</p>
              ) : (
                project.resourceNeeds.map((n) => (
                  <div className="need" key={n.id}>
                    <div className="role">
                      {n.quantity}× {n.role ?? n.skill}
                    </div>
                    <div className="detail-line">
                      {[
                        n.skill,
                        n.hoursPerWeek ? `${n.hoursPerWeek} hrs/week` : null,
                        n.durationWeeks ? `for ${n.durationWeeks} weeks` : null,
                        n.kind === 'sprint' ? 'sprint' : 'ongoing',
                      ]
                        .filter(Boolean)
                        .join(' · ')}
                    </div>
                  </div>
                ))
              )}
            </div>
            {(project.digitalResourceNeeds.length > 0 || isCharityOwner) && (
              <div className="panel" style={{ marginTop: 20 }}>
                <h3>Digital resources needed</h3>
                {project.digitalResourceNeeds.length === 0 ? (
                  <p className="about">No digital resources requested yet.</p>
                ) : (
                  project.digitalResourceNeeds.map((n) => (
                    <div className="need" key={n.id}>
                      <div className="role">
                        {n.quantity ? `${n.quantity} ` : ''}
                        {n.unit ? `${n.unit} · ` : ''}
                        {KIND_LABEL[n.kind] ?? n.kind}
                      </div>
                      {n.description && <div className="detail-line">{n.description}</div>}
                    </div>
                  ))
                )}
                {isCharityOwner && project.status === 'published' && (
                  <div style={{ marginTop: 16 }}>
                    <h3 style={{ marginTop: 0 }}>Edit digital resources needed</h3>
                    <DigitalNeedsEditor
                      projectId={id}
                      initialNeeds={project.digitalResourceNeeds}
                    />
                  </div>
                )}
              </div>
            )}
            {canSeeRun && (
              <div className="panel" style={{ marginTop: 20 }}>
                <AgentRunPanel
                  run={runDetail!.run}
                  milestones={runDetail!.milestones}
                  budget={runDetail!.budget}
                  staging={runDetail!.staging}
                  production={runDetail!.production}
                  canReview={isCharityOwner}
                />
              </div>
            )}
            {(workspace || (progress && progress.inDelivery)) && (
              <div className="panel" style={{ marginTop: 20 }}>
                <DeliveryProgress
                  progress={progress}
                  workspaceId={workspace?.workspaceId ?? null}
                />
              </div>
            )}
            {impact && (
              <div className="panel" style={{ marginTop: 20 }}>
                <ImpactSummary impact={impact} />
              </div>
            )}
            {/* US-8.3 — renders nothing unless the viewer is a party to a
                conversation on this project, so it is safe on a public page. */}
            <Conversations projectId={id} viewerId={session?.userId ?? null} />
            {isCharityOwner && (
              <div className="panel" style={{ marginTop: 20 }}>
                <h3>Gift offers</h3>
                {charityGifts.length === 0 ? (
                  <p className="about">No resource gifts have been offered yet.</p>
                ) : (
                  charityGifts.map((g) => (
                    <div className="gift-row" key={g.id}>
                      <div className="gift-main">
                        <div className="role">
                          {g.quantity ? `${g.quantity} ` : ''}
                          {g.unit ? `${g.unit} · ` : ''}
                          {KIND_LABEL[g.kind] ?? g.kind}
                        </div>
                        {g.note && <div className="detail-line">{g.note}</div>}
                        {g.reason && <div className="detail-line">Reason: {g.reason}</div>}
                      </div>
                      <span className={`gift-chip gift-chip-${g.status}`}>
                        {GIFT_STATUS_LABEL[g.status] ?? g.status}
                      </span>
                      <GiftActions giftId={g.id} status={g.status} perspective="charity" />
                    </div>
                  ))
                )}
              </div>
            )}
            {isCharityOwner && (
              <div className="panel" style={{ marginTop: 20 }}>
                <h3>Agent delivery offers</h3>
                {charityComputePledges.length === 0 ? (
                  <p className="about">No compute pledges have been proposed yet.</p>
                ) : (
                  charityComputePledges.map((p) => (
                    <div className="gift-row" key={p.id}>
                      <div className="gift-main">
                        <div className="role">
                          {TEMPLATE_LABEL[p.templateCode] ?? p.templateCode} · £
                          {(p.budgetCommittedMinor / 100).toFixed(2)}
                        </div>
                        {p.reason && <div className="detail-line">Reason: {p.reason}</div>}
                      </div>
                      <span className={`gift-chip gift-chip-${p.status}`}>
                        {PLEDGE_STATUS_LABEL[p.status] ?? p.status}
                      </span>
                      <ComputePledgeActions pledgeId={p.id} status={p.status} />
                    </div>
                  ))
                )}
              </div>
            )}
          </div>

          <aside>
            <div className="panel support-card">
              <h3>Public support</h3>
              <div className="meter">
                <div className="meter-track">
                  <div
                    className="meter-fill"
                    style={{
                      /* ~200 reads as a very well-backed project — keeps a strong
                         score visually substantial without ever overflowing. */
                      width: `${Math.max(6, Math.min(100, ((score?.supportScore ?? 0) / 200) * 100))}%`,
                    }}
                  />
                </div>
                <span className="meter-val">{score?.supportScore ?? 0}</span>
              </div>
              <div className="meter-cap">
                {supportCount} {supportCount === 1 ? 'supporter' : 'supporters'} on HodorHub
              </div>
              <SupportButton projectId={id} />
              <p className="support-note">
                Merit, not money: companies discover projects by how much the public backs them.
              </p>
            </div>
            {isCorpManager && project.status === 'published' && (
              <div className="panel" style={{ marginTop: 20 }}>
                <h3>Offer a resource gift</h3>
                <OfferGiftForm
                  projectId={id}
                  corporationOrgId={userOrg!.organisationId}
                  needs={project.digitalResourceNeeds}
                />
                {corpGifts.length > 0 && (
                  <div style={{ marginTop: 16 }}>
                    <h3 style={{ marginTop: 0 }}>Your offers</h3>
                    {corpGifts.map((g) => (
                      <div className="gift-row" key={g.id}>
                        <div className="gift-main">
                          <div className="role">
                            {g.quantity ? `${g.quantity} ` : ''}
                            {g.unit ? `${g.unit} · ` : ''}
                            {KIND_LABEL[g.kind] ?? g.kind}
                          </div>
                          {g.reason && <div className="detail-line">Reason: {g.reason}</div>}
                        </div>
                        <span className={`gift-chip gift-chip-${g.status}`}>
                          {GIFT_STATUS_LABEL[g.status] ?? g.status}
                        </span>
                        <GiftActions giftId={g.id} status={g.status} perspective="corp" />
                      </div>
                    ))}
                  </div>
                )}
              </div>
            )}
            {isCorpManager && (
              <div className="panel" style={{ marginTop: 20 }}>
                <h3>Fund agent delivery</h3>
                {project.status === 'published' &&
                  (eligibleTemplates.length > 0 ? (
                    <FundAgentDeliveryForm
                      projectId={id}
                      corporationOrgId={userOrg!.organisationId}
                      templates={eligibleTemplates}
                    />
                  ) : (
                    // US-11.12 — not offered rather than rejected after the click.
                    <p className="support-note">
                      Agent delivery is not available for this kind of project yet. The agents are
                      only used for project shapes they have been proven to deliver.
                    </p>
                  ))}
                {corpComputePledges.length > 0 && (
                  <div style={{ marginTop: 16 }}>
                    <h3 style={{ marginTop: 0 }}>Your compute pledges</h3>
                    {corpComputePledges.map((p) => (
                      <div className="gift-row" key={p.id}>
                        <div className="gift-main">
                          <div className="role">
                            {TEMPLATE_LABEL[p.templateCode] ?? p.templateCode} · £
                            {(p.budgetCommittedMinor / 100).toFixed(2)}
                          </div>
                          {p.reason && <div className="detail-line">Reason: {p.reason}</div>}
                        </div>
                        <span className={`gift-chip gift-chip-${p.status}`}>
                          {PLEDGE_STATUS_LABEL[p.status] ?? p.status}
                        </span>
                      </div>
                    ))}
                  </div>
                )}
              </div>
            )}
          </aside>
        </div>
      </div>
    </section>
  );
}
