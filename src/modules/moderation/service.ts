import { eq } from 'drizzle-orm';
import { db as defaultDb } from '@/db';
import { contentReports, auditLog, outbox } from '@/db/schema';
import {
  isPlatformAdmin,
  NotFoundError,
  ForbiddenError,
  InvalidStateError,
} from '@/modules/identity';
import { getProjectRef, archiveByAdmin } from '@/modules/projects';

/**
 * Moderation — user reports (US-9.2) and admin review/takedown (US-9.1). Owns
 * `content_reports`; removal delegates to Projects.archiveByAdmin (never touches
 * the projects table directly). Admin actions are audit-logged.
 */
type Db = typeof defaultDb;
type Tx = Parameters<Parameters<Db['transaction']>[0]>[0];
type Executor = Db | Tx;

async function assertAdmin(exec: Executor, userId: string) {
  if (!(await isPlatformAdmin(userId, exec))) throw new ForbiddenError('Admin access required.');
}

/** US-9.2 — any signed-in user reports a project. */
export async function reportContent(
  reporterUserId: string,
  projectId: string,
  reason: string,
  db: Db = defaultDb,
): Promise<{ reportId: string }> {
  if (!reason?.trim()) throw new InvalidStateError('A reason is required.');
  const ref = await getProjectRef(projectId, db);
  if (!ref) throw new NotFoundError('Project');
  return db.transaction(async (tx) => {
    const [row] = await tx
      .insert(contentReports)
      .values({ reporterUserId, projectId, reason: reason.trim(), status: 'open' })
      .returning({ id: contentReports.id });
    await tx
      .insert(outbox)
      .values({ eventType: 'ContentReported', payload: { projectId, reportId: row!.id } });
    return { reportId: row!.id };
  });
}

/** US-9.1 — the admin moderation queue. */
export async function listOpenReports(adminUserId: string, db: Db = defaultDb) {
  await assertAdmin(db, adminUserId);
  return db.query.contentReports.findMany({ where: eq(contentReports.status, 'open') });
}

/** US-9.1 — admin resolves a report: remove the project or dismiss the report. */
export async function resolveReport(
  adminUserId: string,
  reportId: string,
  action: 'remove' | 'dismiss',
  reason: string | null,
  db: Db = defaultDb,
): Promise<void> {
  await db.transaction(async (tx) => {
    await assertAdmin(tx, adminUserId);
    const report = await tx.query.contentReports.findFirst({
      where: eq(contentReports.id, reportId),
    });
    if (!report) throw new NotFoundError('Report');
    if (report.status !== 'open') throw new InvalidStateError(`Report already ${report.status}.`);

    if (action === 'remove') await archiveByAdmin(report.projectId, tx);

    await tx
      .update(contentReports)
      .set({
        status: action === 'remove' ? 'actioned' : 'dismissed',
        reviewedBy: adminUserId,
        decidedReason: reason,
      })
      .where(eq(contentReports.id, reportId));
    await tx.insert(auditLog).values({
      actorId: adminUserId,
      action: `report.${action}`,
      entity: 'project',
      entityId: report.projectId,
      metadata: { reportId, reason },
    });
  });
}

/** US-9.1 — admin removes a project directly (without a prior report). */
export async function removeProject(
  adminUserId: string,
  projectId: string,
  reason: string,
  db: Db = defaultDb,
): Promise<void> {
  await db.transaction(async (tx) => {
    await assertAdmin(tx, adminUserId);
    await archiveByAdmin(projectId, tx);
    await tx.insert(auditLog).values({
      actorId: adminUserId,
      action: 'project.removed',
      entity: 'project',
      entityId: projectId,
      metadata: { reason },
    });
  });
}
