import { and, eq } from 'drizzle-orm';
import { z } from 'zod';
import { db as defaultDb } from '@/db';
import {
  interests,
  pledges,
  deliveryWorkspaces,
  computePledges,
  resourceGifts,
  outbox,
} from '@/db/schema';
import {
  findMembership,
  NotFoundError,
  ForbiddenError,
  InvalidStateError,
} from '@/modules/identity';
import { getProjectRef, beginDelivery } from '@/modules/projects';
import {
  createRunFromPledge,
  AGENT_DELIVERY_TEMPLATE_CODES,
  assertTemplateEligible,
} from '@/modules/agent-delivery';

/**
 * Commitments service — US-5.1 (express interest), US-5.2 (pledge donated time),
 * US-5.3 (charity accepts/declines), US-11.1/11.2 (compute pledges). Owns `interests`,
 * `pledges`, `delivery_workspaces`, `compute_pledges` (Epic 11 funded-compute budget).
 * Reads/acts on projects and agent-delivery only through their public interfaces
 * (getProjectRef / beginDelivery for projects; createRunFromPledge for agent delivery),
 * never their tables.
 */
type Db = typeof defaultDb;
type Tx = Parameters<Parameters<Db['transaction']>[0]>[0];
type Executor = Db | Tx;

export const pledgeSchema = z.object({
  corporationOrgId: z.string().uuid(),
  resourceType: z.string().trim().min(2).max(120),
  quantity: z.number().int().min(1).max(999),
  cadence: z.string().trim().max(80).optional(),
  durationWeeks: z.number().int().min(1).max(104).optional(),
});
export type PledgeInput = z.infer<typeof pledgeSchema>;

// ── Authorization helpers ─────────────────────────────────────────────────────
export async function assertCorpManager(exec: Executor, userId: string, corporationOrgId: string) {
  const m = await findMembership(userId, corporationOrgId, exec);
  if (!m) throw new NotFoundError('Organisation'); // not a member → don't leak
  if (m.role !== 'csr_manager') throw new ForbiddenError('Only a CSR manager can do this.');
}

// A charity_owner acting on a pledge for their own project (US-5.3).
async function loadPledgeAsCharityOwner(exec: Executor, userId: string, pledgeId: string) {
  const pledge = await exec.query.pledges.findFirst({ where: eq(pledges.id, pledgeId) });
  if (!pledge) throw new NotFoundError('Pledge');
  const ref = await getProjectRef(pledge.projectId, exec);
  if (!ref) throw new NotFoundError('Pledge');
  const m = await findMembership(userId, ref.charityOrgId, exec);
  if (!m) throw new NotFoundError('Pledge'); // cross-tenant: no existence leak
  if (m.role !== 'charity_owner') throw new ForbiddenError();
  return { pledge, charityOrgId: ref.charityOrgId };
}

// ── US-5.1 express interest ────────────────────────────────────────────────────
export async function expressInterest(
  actingUserId: string,
  projectId: string,
  corporationOrgId: string,
  db: Db = defaultDb,
): Promise<{ interestId: string }> {
  z.string().uuid().parse(corporationOrgId);
  return db.transaction(async (tx) => {
    await assertCorpManager(tx, actingUserId, corporationOrgId);
    const ref = await getProjectRef(projectId, tx);
    if (!ref) throw new NotFoundError('Project');
    if (ref.status !== 'published') {
      throw new InvalidStateError('This project is not open for new interest.');
    }
    const [row] = await tx
      .insert(interests)
      .values({ projectId, corporationOrgId })
      .returning({ id: interests.id });
    await tx.insert(outbox).values({
      eventType: 'InterestExpressed',
      payload: { projectId, corporationOrgId },
    });
    return { interestId: row!.id };
  });
}

// ── US-5.2 pledge donated time ─────────────────────────────────────────────────
export async function pledgeResources(
  actingUserId: string,
  projectId: string,
  input: PledgeInput,
  db: Db = defaultDb,
): Promise<{ pledgeId: string }> {
  const v = pledgeSchema.parse(input);
  return db.transaction(async (tx) => {
    await assertCorpManager(tx, actingUserId, v.corporationOrgId);
    const ref = await getProjectRef(projectId, tx);
    if (!ref) throw new NotFoundError('Project');
    if (ref.status !== 'published') {
      throw new InvalidStateError('This project is not open for new pledges.');
    }
    const [row] = await tx
      .insert(pledges)
      .values({
        projectId,
        corporationOrgId: v.corporationOrgId,
        resourceType: v.resourceType,
        quantity: v.quantity,
        cadence: v.cadence ?? null,
        durationWeeks: v.durationWeeks ?? null,
        status: 'proposed',
      })
      .returning({ id: pledges.id });
    await tx.insert(outbox).values({
      eventType: 'PledgeProposed',
      payload: { pledgeId: row!.id, projectId, corporationOrgId: v.corporationOrgId },
    });
    return { pledgeId: row!.id };
  });
}

/** Cross-module reference to a pledge (used by Delivery to resolve the owning corp). */
export async function getPledgeRef(pledgeId: string, exec: Executor = defaultDb) {
  const p = await exec.query.pledges.findFirst({
    where: eq(pledges.id, pledgeId),
    columns: { id: true, projectId: true, corporationOrgId: true, status: true },
  });
  return p ?? null;
}

/** US-5.3 — charity views pledges on its project. */
export async function listPledgesForProject(
  actingUserId: string,
  projectId: string,
  db: Db = defaultDb,
) {
  const ref = await getProjectRef(projectId, db);
  if (!ref) throw new NotFoundError('Project');
  const m = await findMembership(actingUserId, ref.charityOrgId, db);
  if (!m) throw new NotFoundError('Project');
  if (m.role !== 'charity_owner') throw new ForbiddenError();
  return db.query.pledges.findMany({ where: eq(pledges.projectId, projectId) });
}

// ── US-5.3 accept ──────────────────────────────────────────────────────────────
export async function acceptPledge(
  actingUserId: string,
  pledgeId: string,
  db: Db = defaultDb,
): Promise<{ deliveryWorkspaceId: string }> {
  try {
    return await acceptPledgeTx(actingUserId, pledgeId, db);
  } catch (e) {
    // DB backstop (M2): partial unique index → one accepted pledge per project.
    // Drizzle wraps the pg error, so the SQLSTATE may be on `.cause`.
    if (pgErrorCode(e) === '23505') {
      throw new InvalidStateError('This project already has an accepted pledge.');
    }
    throw e;
  }
}

/** Extract a Postgres SQLSTATE from an error or its (possibly wrapped) cause. */
function pgErrorCode(e: unknown): string | undefined {
  if (e && typeof e === 'object') {
    const code = (e as { code?: unknown }).code;
    if (typeof code === 'string') return code;
    if ('cause' in e) return pgErrorCode((e as { cause?: unknown }).cause);
  }
  return undefined;
}

function acceptPledgeTx(
  actingUserId: string,
  pledgeId: string,
  db: Db,
): Promise<{ deliveryWorkspaceId: string }> {
  return db.transaction(async (tx) => {
    const { pledge } = await loadPledgeAsCharityOwner(tx, actingUserId, pledgeId);
    if (pledge.status !== 'proposed') {
      throw new InvalidStateError(`Pledge already ${pledge.status}.`);
    }
    await tx
      .update(pledges)
      .set({ status: 'accepted', decidedBy: actingUserId })
      .where(eq(pledges.id, pledgeId));

    // Move the project into delivery (published → in_delivery) atomically.
    await beginDelivery(pledge.projectId, tx);

    const [ws] = await tx
      .insert(deliveryWorkspaces)
      .values({ projectId: pledge.projectId, pledgeId })
      .returning({ id: deliveryWorkspaces.id });

    await tx.insert(outbox).values({
      eventType: 'PledgeAccepted',
      payload: { pledgeId, projectId: pledge.projectId, corporationOrgId: pledge.corporationOrgId },
    });
    return { deliveryWorkspaceId: ws!.id };
  });
}

// ── US-5.3 decline ───────────────────────────────────────────────────────────
export async function declinePledge(
  actingUserId: string,
  pledgeId: string,
  reason: string,
  db: Db = defaultDb,
): Promise<void> {
  if (!reason?.trim()) throw new InvalidStateError('A decline reason is required.');
  await db.transaction(async (tx) => {
    const { pledge } = await loadPledgeAsCharityOwner(tx, actingUserId, pledgeId);
    if (pledge.status !== 'proposed') {
      throw new InvalidStateError(`Pledge already ${pledge.status}.`);
    }
    await tx
      .update(pledges)
      .set({ status: 'declined', decidedBy: actingUserId, reason: reason.trim() })
      .where(eq(pledges.id, pledgeId));
    await tx.insert(outbox).values({
      eventType: 'PledgeDeclined',
      payload: {
        pledgeId,
        projectId: pledge.projectId,
        corporationOrgId: pledge.corporationOrgId,
        reason: reason.trim(),
      },
    });
  });
}

// ── Epic 11 trigger: compute pledges ──────────────────────────────────────────
export const computeBudgetSchema = z.object({
  corporationOrgId: z.string().uuid(),
  // US-11.12 — derived from the AgentDelivery registry, never restated here,
  // so the schema and the allow-list cannot drift apart.
  templateCode: z.enum(AGENT_DELIVERY_TEMPLATE_CODES),
  budgetMinor: z.number().int().min(1).max(10_000_00),
});
export type ComputeBudgetInput = z.infer<typeof computeBudgetSchema>;

/** US-11.1 — a CSR manager funds a compute budget for a published project. */
export async function fundComputeBudget(
  actingUserId: string,
  projectId: string,
  input: ComputeBudgetInput,
  db: Db = defaultDb,
): Promise<{ computePledgeId: string }> {
  const v = computeBudgetSchema.parse(input);
  return db.transaction(async (tx) => {
    await assertCorpManager(tx, actingUserId, v.corporationOrgId);
    const ref = await getProjectRef(projectId, tx);
    if (!ref) throw new NotFoundError('Project');
    if (ref.status !== 'published') throw new InvalidStateError('Project is not open for funding.');
    // US-11.12 — the allow-list is about the PROJECT, not just the string sent:
    // a template may only be funded for a shape the agents are proven on.
    assertTemplateEligible(v.templateCode, ref.category);
    const [row] = await tx
      .insert(computePledges)
      .values({
        projectId,
        corporationOrgId: v.corporationOrgId,
        templateCode: v.templateCode,
        budgetCommittedMinor: v.budgetMinor,
      })
      .returning({ id: computePledges.id });
    return { computePledgeId: row!.id };
  });
}

/** US-11.2 — the charity accepts a compute pledge; a run is authorised + escrowed. */
export async function acceptComputePledge(
  actingUserId: string,
  computePledgeId: string,
  db: Db = defaultDb,
): Promise<{ runId: string }> {
  return db.transaction(async (tx) => {
    const pledge = await tx.query.computePledges.findFirst({
      where: eq(computePledges.id, computePledgeId),
    });
    if (!pledge) throw new NotFoundError('Compute pledge');
    const ref = await getProjectRef(pledge.projectId, tx);
    if (!ref) throw new NotFoundError('Compute pledge');
    const m = await findMembership(actingUserId, ref.charityOrgId, tx);
    if (!m) throw new NotFoundError('Compute pledge'); // cross-tenant: no existence leak
    if (m.role !== 'charity_owner') throw new ForbiddenError();
    if (pledge.status !== 'proposed')
      throw new InvalidStateError(`Compute pledge already ${pledge.status}.`);

    await tx
      .update(computePledges)
      .set({ status: 'accepted', decidedBy: actingUserId })
      .where(eq(computePledges.id, computePledgeId));
    await beginDelivery(pledge.projectId, tx);
    const { runId } = await createRunFromPledge(
      tx,
      {
        id: pledge.id,
        projectId: pledge.projectId,
        corporationOrgId: pledge.corporationOrgId,
        templateCode: pledge.templateCode,
        budgetCommittedMinor: pledge.budgetCommittedMinor,
      },
      ref.charityOrgId,
    );
    await tx.insert(outbox).values({
      eventType: 'ComputePledgeAccepted',
      payload: {
        computePledgeId,
        projectId: pledge.projectId,
        corporationOrgId: pledge.corporationOrgId,
        runId,
      },
    });
    return { runId };
  });
}

/** US-11.1/2 — charity_owner views compute pledges on their project. */
export async function listComputePledgesForProject(
  actingUserId: string,
  projectId: string,
  db: Db = defaultDb,
) {
  const ref = await getProjectRef(projectId, db);
  if (!ref) throw new NotFoundError('Project');
  const m = await findMembership(actingUserId, ref.charityOrgId, db);
  if (!m) throw new NotFoundError('Project');
  if (m.role !== 'charity_owner') throw new ForbiddenError();
  return db.query.computePledges.findMany({ where: eq(computePledges.projectId, projectId) });
}

/** US-11.1 — a corp's own compute pledges on a project. */
export async function listComputePledgesForCorp(
  actingUserId: string,
  projectId: string,
  corporationOrgId: string,
  db: Db = defaultDb,
) {
  await assertCorpManager(db, actingUserId, corporationOrgId);
  return db.query.computePledges.findMany({
    where: and(
      eq(computePledges.projectId, projectId),
      eq(computePledges.corporationOrgId, corporationOrgId),
    ),
  });
}

/** US-11.2 — charity_owner declines a proposed compute pledge. */
export async function declineComputePledge(
  actingUserId: string,
  computePledgeId: string,
  reason: string | undefined,
  db: Db = defaultDb,
): Promise<void> {
  await db.transaction(async (tx) => {
    const pledge = await tx.query.computePledges.findFirst({
      where: eq(computePledges.id, computePledgeId),
    });
    if (!pledge) throw new NotFoundError('Compute pledge');
    const ref = await getProjectRef(pledge.projectId, tx);
    if (!ref) throw new NotFoundError('Compute pledge');
    const m = await findMembership(actingUserId, ref.charityOrgId, tx);
    if (!m) throw new NotFoundError('Compute pledge');
    if (m.role !== 'charity_owner') throw new ForbiddenError();
    if (pledge.status !== 'proposed')
      throw new InvalidStateError(`Compute pledge already ${pledge.status}.`);
    await tx
      .update(computePledges)
      .set({ status: 'declined', decidedBy: actingUserId, reason: reason ?? null })
      .where(eq(computePledges.id, computePledgeId));
    await tx.insert(outbox).values({
      eventType: 'ComputePledgeDeclined',
      payload: {
        computePledgeId,
        projectId: pledge.projectId,
        corporationOrgId: pledge.corporationOrgId,
      },
    });
  });
}

/**
 * US-7.1 — every resource pledge this corporation has made, across all
 * projects, for its CSR dashboard. Org-scoped rather than project-scoped: the
 * dashboard aggregates, and doing that by looping the per-project read would
 * be both slower and easy to get wrong.
 */
export async function listPledgesForCorpOrg(
  actingUserId: string,
  corporationOrgId: string,
  db: Db = defaultDb,
) {
  await assertCorpManager(db, actingUserId, corporationOrgId);
  return db.query.pledges.findMany({
    where: eq(pledges.corporationOrgId, corporationOrgId),
  });
}

/** US-7.1 — every compute budget this corporation has funded. */
export async function listComputePledgesForCorpOrg(
  actingUserId: string,
  corporationOrgId: string,
  db: Db = defaultDb,
) {
  await assertCorpManager(db, actingUserId, corporationOrgId);
  return db.query.computePledges.findMany({
    where: eq(computePledges.corporationOrgId, corporationOrgId),
  });
}

// ── Corporate relationship (US-8.3) ──────────────────────────────────────────

export type RelationshipSignal = 'interest' | 'pledge' | 'resource_gift' | 'compute_pledge';

export interface CorporateRelationship {
  corporationOrgId: string;
  /** Every signal type present, for labelling the conversation. */
  signals: RelationshipSignal[];
  /** Earliest signal — "talking since". */
  since: Date;
}

/**
 * Every corporation that has any relationship with this project — expressed
 * interest, pledged, offered a resource gift, or funded a compute budget.
 *
 * Commitments owns all four tables, so this is the ONE definition of "this
 * corporation is involved with this project". A caller that computed it itself
 * would query four tables it does not own and would fork the definition the
 * moment a fifth signal is added.
 *
 * **Status is ignored — a `declined` or `withdrawn` row still counts.** If a
 * decline revoked the relationship, declining a pledge would silently strand a
 * conversation both parties could read yesterday, and "why did you decline?" is
 * exactly the conversation worth having (US-8.3).
 *
 * **This read carries NO authorisation of its own** — same contract as
 * `getPledgeRef` and `getProjectRef`. Who has expressed interest in a project is
 * charity-only information, so a caller MUST establish the caller's standing
 * before asking this. Messaging does exactly that: its participation check runs
 * first, so a stranger never reaches this read at all.
 */
export async function listRelatedCorporationsForProject(
  projectId: string,
  exec: Executor = defaultDb,
): Promise<CorporateRelationship[]> {
  const [interestRows, pledgeRows, giftRows, computeRows] = await Promise.all([
    exec.query.interests.findMany({
      where: eq(interests.projectId, projectId),
      columns: { corporationOrgId: true, createdAt: true },
    }),
    exec.query.pledges.findMany({
      where: eq(pledges.projectId, projectId),
      columns: { corporationOrgId: true, createdAt: true },
    }),
    exec.query.resourceGifts.findMany({
      where: eq(resourceGifts.projectId, projectId),
      columns: { corporationOrgId: true, createdAt: true },
    }),
    exec.query.computePledges.findMany({
      where: eq(computePledges.projectId, projectId),
      columns: { corporationOrgId: true, createdAt: true },
    }),
  ]);

  // Merged in memory rather than as a four-way SQL UNION: the row counts are
  // single digits, and a hand-rolled union is the thing nobody remembers to
  // update when a fifth signal lands.
  const byOrg = new Map<string, CorporateRelationship>();
  const add = (
    rows: { corporationOrgId: string; createdAt: Date }[],
    signal: RelationshipSignal,
  ) => {
    for (const r of rows) {
      const existing = byOrg.get(r.corporationOrgId);
      if (!existing) {
        byOrg.set(r.corporationOrgId, {
          corporationOrgId: r.corporationOrgId,
          signals: [signal],
          since: r.createdAt,
        });
        continue;
      }
      if (!existing.signals.includes(signal)) existing.signals.push(signal);
      if (r.createdAt < existing.since) existing.since = r.createdAt;
    }
  };
  add(interestRows, 'interest');
  add(pledgeRows, 'pledge');
  add(giftRows, 'resource_gift');
  add(computeRows, 'compute_pledge');

  return [...byOrg.values()].sort((a, b) => a.since.getTime() - b.since.getTime());
}

/**
 * The US-8.3 gate, implemented over the read above so there is one definition in
 * two shapes. Carries no authorisation of its own — see the note there.
 */
export async function hasCorporateRelationship(
  projectId: string,
  corporationOrgId: string,
  exec: Executor = defaultDb,
): Promise<boolean> {
  const related = await listRelatedCorporationsForProject(projectId, exec);
  return related.some((r) => r.corporationOrgId === corporationOrgId);
}
