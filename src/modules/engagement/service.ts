import { and, count, eq } from 'drizzle-orm';
import { db as defaultDb } from '@/db';
import { onPlatformSupports, engagementEvents, outbox } from '@/db/schema';
import { NotFoundError, InvalidStateError } from '@/modules/identity/errors';
import { getProjectRef } from '@/modules/projects';
import { computeScores, applyScores, type Contribution } from '@/modules/scoring';

// On-platform support weight (SUPPORT_SCORE_MODEL §2).
const ON_PLATFORM_SUPPORT_WEIGHT = 1;
const MS_PER_DAY = 1000 * 60 * 60 * 24;

/**
 * Engagement — owns on-platform support (US-3.3). A support toggles the
 * materialised score via Scoring in the same transaction. Social connections +
 * ingested engagement (US-3.4/3.5) live here later.
 */
type Db = typeof defaultDb;
type Tx = Parameters<Parameters<Db['transaction']>[0]>[0];
type Executor = Db | Tx;

const PUBLIC = ['published', 'in_delivery', 'completed'];

async function supportCount(exec: Executor, projectId: string): Promise<number> {
  const [row] = await exec
    .select({ c: count() })
    .from(onPlatformSupports)
    .where(eq(onPlatformSupports.projectId, projectId));
  return Number(row!.c);
}

/**
 * Recompute a project's scores from its engagement contributions and materialise
 * them. Gathers per-source, per-event contributions (on-platform support +
 * CONFIRMED social engagement) with ages, then delegates the maths (log
 * compression, momentum decay, per-source cap) to Scoring. Flagged/provisional
 * events do not count. Reads only Engagement's own tables.
 */
export async function recomputeProjectScore(exec: Executor, projectId: string): Promise<number> {
  const now = Date.now();
  const supports = await exec
    .select({ createdAt: onPlatformSupports.createdAt })
    .from(onPlatformSupports)
    .where(eq(onPlatformSupports.projectId, projectId));
  const events = await exec
    .select({
      source: engagementEvents.source,
      effectiveValue: engagementEvents.effectiveValue,
      occurredAt: engagementEvents.occurredAt,
    })
    .from(engagementEvents)
    .where(
      and(eq(engagementEvents.projectId, projectId), eq(engagementEvents.status, 'confirmed')),
    );

  const contribs: Contribution[] = [
    ...supports.map((s) => ({
      source: 'on_platform',
      value: ON_PLATFORM_SUPPORT_WEIGHT,
      ageDays: (now - s.createdAt.getTime()) / MS_PER_DAY,
    })),
    ...events.map((e) => ({
      source: e.source,
      value: e.effectiveValue,
      ageDays: (now - e.occurredAt.getTime()) / MS_PER_DAY,
    })),
  ];

  const scores = computeScores(contribs);
  await applyScores(projectId, scores, exec);
  return scores.rawR;
}

/** US-3.3 — support a project. Idempotent (one support per user per project). */
export async function supportProject(
  userId: string,
  projectId: string,
  db: Db = defaultDb,
): Promise<{ supportCount: number }> {
  return db.transaction(async (tx) => {
    const ref = await getProjectRef(projectId, tx);
    if (!ref) throw new NotFoundError('Project');
    if (!PUBLIC.includes(ref.status))
      throw new InvalidStateError('This project is not open for support.');

    await tx.insert(onPlatformSupports).values({ projectId, userId }).onConflictDoNothing();
    await recomputeProjectScore(tx, projectId);
    const n = await supportCount(tx, projectId);
    await tx
      .insert(outbox)
      .values({ eventType: 'ProjectSupported', payload: { projectId, userId } });
    return { supportCount: n };
  });
}

/** US-3.3 — undo support. Idempotent. */
export async function unsupportProject(
  userId: string,
  projectId: string,
  db: Db = defaultDb,
): Promise<{ supportCount: number }> {
  return db.transaction(async (tx) => {
    await tx
      .delete(onPlatformSupports)
      .where(
        and(eq(onPlatformSupports.projectId, projectId), eq(onPlatformSupports.userId, userId)),
      );
    await recomputeProjectScore(tx, projectId);
    const n = await supportCount(tx, projectId);
    return { supportCount: n };
  });
}

export async function getSupportInfo(
  projectId: string,
  userId: string | null,
  db: Db = defaultDb,
): Promise<{ supportCount: number; supported: boolean }> {
  const n = await supportCount(db, projectId);
  const mine = userId
    ? Boolean(
        await db.query.onPlatformSupports.findFirst({
          where: and(
            eq(onPlatformSupports.projectId, projectId),
            eq(onPlatformSupports.userId, userId),
          ),
        }),
      )
    : false;
  return { supportCount: n, supported: mine };
}
