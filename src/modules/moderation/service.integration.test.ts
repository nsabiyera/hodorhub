import { describe, it, expect } from 'vitest';
import { eq } from 'drizzle-orm';
import { testDb } from '@/test/db';
import { contentReports, auditLog } from '@/db/schema';
import {
  registerCharity,
  approveVerification,
  createPlatformAdmin,
  ForbiddenError,
  NotFoundError,
  InvalidStateError,
} from '@/modules/identity';
import {
  createDraftProject,
  setResourceNeeds,
  publishProject,
  getPublishedProject,
} from '@/modules/projects';
import { reportContent, listOpenReports, resolveReport } from './service';

const need = {
  skill: 'Backend development',
  role: 'Backend developer',
  kind: 'ongoing' as const,
  quantity: 1,
  hoursPerWeek: 2,
  durationWeeks: 8,
};

async function publishedProject() {
  const admin = await createPlatformAdmin('alex@hodorhub.com', 'admin-password-1', testDb);
  const charity = await registerCharity(
    {
      email: 'petra@goodcause.org',
      password: 'a-strong-password',
      charityName: 'Good Cause',
      regNumber: 'CH-1',
    },
    testDb,
  );
  await approveVerification(charity.verificationRequestId, admin, testDb);
  const { projectId } = await createDraftProject(
    charity.userId,
    {
      charityOrgId: charity.organisationId,
      title: 'Rebuild the community garden',
      description: 'A worthy cause needing a hand.',
      goal: 'Reopen by spring.',
      category: 'software',
    },
    testDb,
  );
  await setResourceNeeds(charity.userId, projectId, [need], testDb);
  await publishProject(charity.userId, projectId, testDb);
  return { admin, charity, projectId };
}

describe('Moderation — report & takedown (US-9.1/9.2)', () => {
  it('a user reports a project; report is queued for admins', async () => {
    const { admin, projectId } = await publishedProject();
    const reporter = await createPlatformAdmin('reporter@x.com', 'password-1234', testDb);
    const { reportId } = await reportContent(reporter, projectId, 'Looks fraudulent', testDb);

    const open = await listOpenReports(admin, testDb);
    expect(open.map((r) => r.id)).toContain(reportId);
  });

  it('reporting a nonexistent project fails; empty reason fails', async () => {
    const reporter = await createPlatformAdmin('r2@x.com', 'password-1234', testDb);
    await expect(
      reportContent(reporter, '00000000-0000-0000-0000-000000000000', 'x', testDb),
    ).rejects.toBeInstanceOf(NotFoundError);
    const { projectId } = await publishedProject();
    await expect(reportContent(reporter, projectId, '   ', testDb)).rejects.toBeInstanceOf(
      InvalidStateError,
    );
  });

  it('a non-admin cannot view the queue or resolve reports', async () => {
    const { projectId } = await publishedProject();
    const reporter = await createPlatformAdmin('r3@x.com', 'password-1234', testDb);
    const { reportId } = await reportContent(reporter, projectId, 'spam', testDb);
    const nonAdmin = await registerCharity(
      {
        email: 'nobody@c.org',
        password: 'a-strong-password',
        charityName: 'Nobody Co',
        regNumber: 'CH-2',
      },
      testDb,
    );
    await expect(listOpenReports(nonAdmin.userId, testDb)).rejects.toBeInstanceOf(ForbiddenError);
    await expect(
      resolveReport(nonAdmin.userId, reportId, 'remove', null, testDb),
    ).rejects.toBeInstanceOf(ForbiddenError);
  });

  it('admin removes the project on resolve → archived, no longer public, report actioned, audited', async () => {
    const { admin, projectId } = await publishedProject();
    const reporter = await createPlatformAdmin('r4@x.com', 'password-1234', testDb);
    const { reportId } = await reportContent(reporter, projectId, 'inappropriate', testDb);

    await resolveReport(admin, reportId, 'remove', 'Confirmed inappropriate', testDb);

    expect(await getPublishedProject(projectId, testDb)).toBeNull(); // removed from public
    const report = await testDb.query.contentReports.findFirst({
      where: eq(contentReports.id, reportId),
    });
    expect(report?.status).toBe('actioned');
    const audits = await testDb.query.auditLog.findMany({
      where: eq(auditLog.entityId, projectId),
    });
    expect(audits.some((a) => a.action === 'report.remove')).toBe(true);
  });

  it('admin dismiss keeps the project; report cannot be resolved twice', async () => {
    const { admin, projectId } = await publishedProject();
    const reporter = await createPlatformAdmin('r5@x.com', 'password-1234', testDb);
    const { reportId } = await reportContent(reporter, projectId, 'not really a problem', testDb);

    await resolveReport(admin, reportId, 'dismiss', null, testDb);
    expect(await getPublishedProject(projectId, testDb)).not.toBeNull(); // still public
    await expect(resolveReport(admin, reportId, 'remove', null, testDb)).rejects.toBeInstanceOf(
      InvalidStateError,
    );
  });
});
