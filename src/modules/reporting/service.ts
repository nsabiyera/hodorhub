import { db as defaultDb } from '@/db';
import { getProjectForOwner, getProjectSummaries } from '@/modules/projects';
import { getSupportInfo } from '@/modules/engagement';
import { getScore } from '@/modules/scoring';
import { getProjectHoursForCharity, getCorporateHours } from '@/modules/delivery';
import {
  listResourceGiftsForProject,
  listResourceGiftsForCorpOrg,
  listPledgesForCorpOrg,
  listComputePledgesForCorpOrg,
} from '@/modules/commitments';
import { getRunForProject, getRunsForCorporation } from '@/modules/agent-delivery';
import { assertEntitlement, FEATURES } from '@/modules/monetisation';

type Db = typeof defaultDb;

/**
 * Reporting (Epic 7) is a READ-ONLY composer. It owns no tables and never
 * queries another context's tables: every figure below comes from the owning
 * module's public read. That is what keeps the reporting surface from quietly
 * becoming a second, divergent definition of "hours" or "support".
 */

/** Gift statuses that count as actually delivered (US-6.5). */
const GIFT_DELIVERED = 'received';

/**
 * US-7.2 — a charity owner's impact summary for one project.
 *
 * Authorisation is `getProjectForOwner`, which throws NotFound for a project
 * outside the caller's charity — so impact data never leaks across tenants and
 * a probe cannot distinguish "not yours" from "does not exist".
 *
 * The invariants this read exists to preserve:
 *  - approved and pending hours are separate totals, never one number (US-6.2a);
 *  - only `received` gifts are delivered — "promised" is never "delivered" (US-6.5);
 *  - agent-delivered work is its own line, never folded into donated hours and
 *    never expressed as support (US-11.9, US-10.4);
 *  - no compute currency: what a corporation spent is its commercial data
 *    (Epic 7 decision 4), so the charity sees runs and outcomes instead.
 */
export async function getProjectImpact(
  actingUserId: string,
  projectId: string,
  db: Db = defaultDb,
) {
  // Authorises first; everything after it is safe to read for this project.
  const project = await getProjectForOwner(actingUserId, projectId, db);

  const [support, score, hours, gifts, run] = await Promise.all([
    getSupportInfo(projectId, null, db),
    getScore(projectId, db),
    getProjectHoursForCharity(actingUserId, projectId, db),
    listResourceGiftsForProject(actingUserId, projectId, db),
    getRunForProject(projectId, db),
  ]);

  const received = gifts.filter((g) => g.status === GIFT_DELIVERED);
  const promised = gifts.filter((g) => g.status === 'offered' || g.status === 'accepted');
  // 'provided' is the corporation's claim; it is not delivered until the
  // charity confirms receipt, so it is counted with neither (US-6.5).
  const awaitingConfirmation = gifts.filter((g) => g.status === 'provided');

  return {
    project: {
      id: project.id,
      title: project.title,
      status: project.status,
      outcomeStory: project.outcomeStory,
      completedAt: project.completedAt,
    },
    support: {
      supporterCount: support.supportCount,
      supportScore: score?.supportScore ?? 0,
      momentumScore: score?.momentumScore ?? 0,
    },
    hours: {
      approvedHours: hours.approvedHours,
      pendingHours: hours.pendingHours,
      volunteerCount: hours.volunteerCount,
    },
    gifts: {
      receivedCount: received.length,
      awaitingConfirmationCount: awaitingConfirmation.length,
      promisedCount: promised.length,
      received,
    },
    // Reported separately by design: agent delivery is a parallel path to human
    // donated time, not a substitute for it, and must never read as either
    // hours or support.
    agentDelivery: run
      ? {
          status: run.run.status,
          phase: run.run.currentPhase,
          milestonesApproved: run.milestones.filter((m) => m.status === 'approved').length,
          milestoneCount: run.milestones.length,
          stagingUrl: run.staging?.url ?? null,
          productionUrl: run.production?.status === 'live' ? (run.production.url ?? null) : null,
        }
      : null,
  };
}

export type ProjectImpact = Awaited<ReturnType<typeof getProjectImpact>>;

/**
 * US-7.1 — a CSR manager's cross-project impact for their own corporation.
 *
 * Authorisation is delegated: every corp-scoped read below re-checks CSR
 * membership of `corporationOrgId` against the database, and each filters by
 * that org, so another corporation's hours, gifts or spend cannot enter a
 * total even by accident.
 *
 * The same refusal-to-sum rules as the per-project summary apply, plus one
 * more that matters most here: compute spend and agent runs live in their own
 * section, in currency and run counts. They are never converted into hours or
 * added to the donated-time headline - agent delivery is reported separately,
 * not as a substitute for it (Epic 11).
 */
export async function getCorporateImpact(
  actingUserId: string,
  corporationOrgId: string,
  db: Db = defaultDb,
) {
  // US-10.5 — gated in the domain, not just the page, so no other caller can
  // reach the dashboard data without the entitlement. Charities are never
  // gated; this path is corporation-only by construction.
  await assertEntitlement(corporationOrgId, FEATURES.csrDashboard, db);

  const [pledges, gifts, computePledges, runs] = await Promise.all([
    listPledgesForCorpOrg(actingUserId, corporationOrgId, db),
    listResourceGiftsForCorpOrg(actingUserId, corporationOrgId, db),
    listComputePledgesForCorpOrg(actingUserId, corporationOrgId, db),
    getRunsForCorporation(corporationOrgId, db),
  ]);

  const acceptedPledges = pledges.filter((p) => p.status === 'accepted');
  const hours = await getCorporateHours(
    actingUserId,
    corporationOrgId,
    acceptedPledges.map((p) => p.id),
    db,
  );

  // Every project this corporation touched, by any route.
  const projectIds = [
    ...new Set([
      ...acceptedPledges.map((p) => p.projectId),
      ...gifts.filter((g) => g.status === GIFT_DELIVERED).map((g) => g.projectId),
      ...computePledges.filter((c) => c.status === 'accepted').map((c) => c.projectId),
    ]),
  ];
  const projects = await getProjectSummaries(projectIds, db);
  const completed = projects.filter((p) => p.status === 'completed');

  return {
    projectsSupported: projects.length,
    hours: {
      approvedHours: hours.approvedHours,
      pendingHours: hours.pendingHours,
      volunteerCount: hours.volunteerCount,
    },
    gifts: {
      receivedCount: gifts.filter((g) => g.status === GIFT_DELIVERED).length,
      awaitingConfirmationCount: gifts.filter((g) => g.status === 'provided').length,
      promisedCount: gifts.filter((g) => g.status === 'offered' || g.status === 'accepted').length,
    },
    // Own section, own units. Never folded into hours above.
    agentDelivery: {
      runCount: runs.length,
      completedRunCount: runs.filter((r) => r.status === 'completed').length,
      committedMinor: runs.reduce((total, r) => total + r.budget.committedMinor, 0),
      consumedMinor: runs.reduce((total, r) => total + r.budget.consumedMinor, 0),
      currency: 'GBP' as const,
    },
    outcomes: completed.map((p) => ({
      projectId: p.id,
      title: p.title,
      outcomeStory: p.outcomeStory,
      completedAt: p.completedAt,
    })),
    projects: projects.map((p) => ({ projectId: p.id, title: p.title, status: p.status })),
  };
}

export type CorporateImpact = Awaited<ReturnType<typeof getCorporateImpact>>;
