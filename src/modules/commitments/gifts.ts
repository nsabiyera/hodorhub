import { and, eq, inArray } from 'drizzle-orm';
import { z } from 'zod';
import { db as defaultDb } from '@/db';
import { resourceGifts, outbox } from '@/db/schema';
import {
  findMembership,
  NotFoundError,
  ForbiddenError,
  InvalidStateError,
  assertOrganisationVerified,
} from '@/modules/identity';
import { getProjectRef, DIGITAL_RESOURCE_KINDS } from '@/modules/projects';
import { assertCorpManager } from './service';

type Db = typeof defaultDb;
type Tx = Parameters<Parameters<Db['transaction']>[0]>[0];
type Executor = Db | Tx;

export const resourceGiftSchema = z.object({
  corporationOrgId: z.string().uuid(),
  needId: z.string().uuid().optional(),
  kind: z.enum(DIGITAL_RESOURCE_KINDS),
  quantity: z.number().int().min(1).max(1_000_000).optional(),
  unit: z.string().trim().max(60).optional(),
  note: z.string().trim().max(500).optional(),
});
export type ResourceGiftInput = z.infer<typeof resourceGiftSchema>;

const LIVE_STATES = ['offered', 'accepted', 'provided'] as const;

// A charity_owner acting on a gift for their own project.
async function loadGiftAsCharityOwner(exec: Executor, userId: string, giftId: string) {
  const g = await exec.query.resourceGifts.findFirst({ where: eq(resourceGifts.id, giftId) });
  if (!g) throw new NotFoundError('Resource gift');
  const ref = await getProjectRef(g.projectId, exec);
  if (!ref) throw new NotFoundError('Resource gift');
  const m = await findMembership(userId, ref.charityOrgId, exec);
  if (!m) throw new NotFoundError('Resource gift'); // cross-tenant: no existence leak
  if (m.role !== 'charity_owner') throw new ForbiddenError();
  return { gift: g };
}

// A csr_manager acting on their corporation's own gift.
async function loadGiftAsCorpManager(exec: Executor, userId: string, giftId: string) {
  const g = await exec.query.resourceGifts.findFirst({ where: eq(resourceGifts.id, giftId) });
  if (!g) throw new NotFoundError('Resource gift');
  await assertCorpManager(exec, userId, g.corporationOrgId); // throws NotFound/Forbidden if not their corp
  return { gift: g };
}

// ── US-5.5 offer ────────────────────────────────────────────────────────────
export async function offerResourceGift(
  actingUserId: string,
  projectId: string,
  input: ResourceGiftInput,
  db: Db = defaultDb,
): Promise<{ giftId: string }> {
  const v = resourceGiftSchema.parse(input);
  return db.transaction(async (tx) => {
    await assertCorpManager(tx, actingUserId, v.corporationOrgId);
    await assertOrganisationVerified(v.corporationOrgId, tx);
    const ref = await getProjectRef(projectId, tx);
    if (!ref) throw new NotFoundError('Project');
    if (ref.status !== 'published') {
      throw new InvalidStateError('This project is not open for new resource gifts.');
    }
    // Natural dedupe: one live offer per (project, corp, need) when a need is targeted.
    if (v.needId) {
      const existing = await tx.query.resourceGifts.findFirst({
        where: and(
          eq(resourceGifts.projectId, projectId),
          eq(resourceGifts.corporationOrgId, v.corporationOrgId),
          eq(resourceGifts.needId, v.needId),
          inArray(resourceGifts.status, [...LIVE_STATES]),
        ),
      });
      if (existing)
        throw new InvalidStateError('You already have an active gift offer for this need.');
    }
    const [row] = await tx
      .insert(resourceGifts)
      .values({
        projectId,
        corporationOrgId: v.corporationOrgId,
        needId: v.needId ?? null,
        kind: v.kind,
        quantity: v.quantity ?? null,
        unit: v.unit ?? null,
        note: v.note ?? null,
        status: 'offered',
      })
      .returning({ id: resourceGifts.id });
    await tx.insert(outbox).values({
      eventType: 'ResourceGiftOffered',
      payload: { giftId: row!.id, projectId, corporationOrgId: v.corporationOrgId },
    });
    return { giftId: row!.id };
  });
}

/** US-5.5 — charity views resource gifts on its project. */
export async function listResourceGiftsForProject(
  actingUserId: string,
  projectId: string,
  db: Db = defaultDb,
) {
  const ref = await getProjectRef(projectId, db);
  if (!ref) throw new NotFoundError('Project');
  const m = await findMembership(actingUserId, ref.charityOrgId, db);
  if (!m) throw new NotFoundError('Project');
  if (m.role !== 'charity_owner') throw new ForbiddenError();
  return db.query.resourceGifts.findMany({ where: eq(resourceGifts.projectId, projectId) });
}

/** US-5.5 — the offering corp views its own gifts on a project. */
export async function listResourceGiftsForCorp(
  actingUserId: string,
  projectId: string,
  corporationOrgId: string,
  db: Db = defaultDb,
) {
  await assertCorpManager(db, actingUserId, corporationOrgId);
  return db.query.resourceGifts.findMany({
    where: and(
      eq(resourceGifts.projectId, projectId),
      eq(resourceGifts.corporationOrgId, corporationOrgId),
    ),
  });
}

// ── US-5.5 accept ───────────────────────────────────────────────────────────
export async function acceptResourceGift(
  actingUserId: string,
  giftId: string,
  db: Db = defaultDb,
): Promise<void> {
  await db.transaction(async (tx) => {
    const { gift } = await loadGiftAsCharityOwner(tx, actingUserId, giftId);
    const [row] = await tx
      .update(resourceGifts)
      .set({ status: 'accepted', decidedBy: actingUserId })
      .where(and(eq(resourceGifts.id, giftId), eq(resourceGifts.status, 'offered')))
      .returning({ id: resourceGifts.id });
    if (!row) throw new InvalidStateError(`Gift already ${gift.status}.`);
    // NOTE: intentionally no beginDelivery / deliveryWorkspaces — a gift is not delivery.
    await tx.insert(outbox).values({
      eventType: 'ResourceGiftAccepted',
      payload: { giftId, projectId: gift.projectId, corporationOrgId: gift.corporationOrgId },
    });
  });
}

// ── US-5.5 decline ──────────────────────────────────────────────────────────
export async function declineResourceGift(
  actingUserId: string,
  giftId: string,
  reason: string,
  db: Db = defaultDb,
): Promise<void> {
  if (!reason?.trim()) throw new InvalidStateError('A decline reason is required.');
  await db.transaction(async (tx) => {
    const { gift } = await loadGiftAsCharityOwner(tx, actingUserId, giftId);
    const [row] = await tx
      .update(resourceGifts)
      .set({ status: 'declined', decidedBy: actingUserId, reason: reason.trim() })
      .where(and(eq(resourceGifts.id, giftId), eq(resourceGifts.status, 'offered')))
      .returning({ id: resourceGifts.id });
    if (!row) throw new InvalidStateError(`Gift already ${gift.status}.`);
    await tx.insert(outbox).values({
      eventType: 'ResourceGiftDeclined',
      payload: {
        giftId,
        projectId: gift.projectId,
        corporationOrgId: gift.corporationOrgId,
        reason: reason.trim(),
      },
    });
  });
}

// ── US-6.5 corp marks provided ────────────────────────────────────────────────
export async function markResourceGiftProvided(
  actingUserId: string,
  giftId: string,
  db: Db = defaultDb,
): Promise<void> {
  await db.transaction(async (tx) => {
    const { gift } = await loadGiftAsCorpManager(tx, actingUserId, giftId);
    const [row] = await tx
      .update(resourceGifts)
      .set({ status: 'provided', providedAt: new Date() })
      .where(and(eq(resourceGifts.id, giftId), eq(resourceGifts.status, 'accepted')))
      .returning({ id: resourceGifts.id });
    if (!row) throw new InvalidStateError(`Gift cannot be marked provided from ${gift.status}.`);
    await tx.insert(outbox).values({
      eventType: 'ResourceGiftProvided',
      payload: { giftId, projectId: gift.projectId, corporationOrgId: gift.corporationOrgId },
    });
  });
}

// ── US-6.5 charity confirms receipt ───────────────────────────────────────────
export async function confirmResourceGiftReceived(
  actingUserId: string,
  giftId: string,
  db: Db = defaultDb,
): Promise<void> {
  await db.transaction(async (tx) => {
    const { gift } = await loadGiftAsCharityOwner(tx, actingUserId, giftId);
    const [row] = await tx
      .update(resourceGifts)
      .set({ status: 'received', receivedAt: new Date() })
      .where(and(eq(resourceGifts.id, giftId), eq(resourceGifts.status, 'provided')))
      .returning({ id: resourceGifts.id });
    if (!row) throw new InvalidStateError(`Gift cannot be confirmed from ${gift.status}.`);
    await tx.insert(outbox).values({
      eventType: 'ResourceGiftReceived',
      payload: { giftId, projectId: gift.projectId, corporationOrgId: gift.corporationOrgId },
    });
  });
}

// ── corp withdraws (any live state, never after received) ─────────────────────
export async function withdrawResourceGift(
  actingUserId: string,
  giftId: string,
  reason: string,
  db: Db = defaultDb,
): Promise<void> {
  if (!reason?.trim()) throw new InvalidStateError('A withdraw reason is required.');
  await db.transaction(async (tx) => {
    const { gift } = await loadGiftAsCorpManager(tx, actingUserId, giftId);
    const [row] = await tx
      .update(resourceGifts)
      .set({ status: 'withdrawn', reason: reason.trim() })
      .where(and(eq(resourceGifts.id, giftId), inArray(resourceGifts.status, [...LIVE_STATES])))
      .returning({ id: resourceGifts.id });
    if (!row) throw new InvalidStateError(`Gift cannot be withdrawn from ${gift.status}.`);
    await tx.insert(outbox).values({
      eventType: 'ResourceGiftWithdrawn',
      payload: {
        giftId,
        projectId: gift.projectId,
        corporationOrgId: gift.corporationOrgId,
        reason: reason.trim(),
      },
    });
  });
}

/** US-7.1 — every resource gift this corporation has offered, across projects. */
export async function listResourceGiftsForCorpOrg(
  actingUserId: string,
  corporationOrgId: string,
  db: Db = defaultDb,
) {
  await assertCorpManager(db, actingUserId, corporationOrgId);
  return db.query.resourceGifts.findMany({
    where: eq(resourceGifts.corporationOrgId, corporationOrgId),
  });
}
