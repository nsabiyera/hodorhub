import { describe, it, expect } from 'vitest';
import { testDb } from '@/test/db';
import { computePledges } from '@/db/schema';
import { TemplateNotEligibleError } from '@/modules/agent-delivery';
import { createDraftProject, setResourceNeeds, publishProject } from '@/modules/projects';
import { twoOrgs } from '@/test/agent-delivery-fixtures';
import { fundComputeBudget } from './service';

const NEED = {
  skill: 'Backend',
  role: 'Dev',
  kind: 'ongoing' as const,
  quantity: 1,
  hoursPerWeek: 2,
  durationWeeks: 8,
};

/** A published project of the given category, owned by the fixture charity. */
async function publishedProject(
  charity: { userId: string; organisationId: string },
  category: string,
) {
  const project = await createDraftProject(
    charity.userId,
    {
      charityOrgId: charity.organisationId,
      title: `A ${category} project`,
      description: 'A worthy cause that needs a hand.',
      goal: 'Reach the finish line.',
      category,
    } as Parameters<typeof createDraftProject>[1],
    testDb,
  );
  await setResourceNeeds(charity.userId, project.projectId, [NEED], testDb);
  await publishProject(charity.userId, project.projectId, testDb);
  return project.projectId;
}

describe('template allow-list at the funding gate (US-11.12)', () => {
  it('funds a project shape the template is proven to deliver', async () => {
    const { charity, corp } = await twoOrgs();
    const projectId = await publishedProject(charity, 'software');

    const { computePledgeId } = await fundComputeBudget(
      corp.userId,
      projectId,
      {
        corporationOrgId: corp.organisationId,
        templateCode: 'static-site',
        budgetMinor: 50000,
      },
      testDb,
    );

    expect(computePledgeId).toBeTruthy();
  });

  it('refuses a project shape the agents are not proven on, and banks no pledge', async () => {
    const { charity, corp } = await twoOrgs();
    const projectId = await publishedProject(charity, 'construction');

    await expect(
      fundComputeBudget(
        corp.userId,
        projectId,
        {
          corporationOrgId: corp.organisationId,
          templateCode: 'static-site',
          budgetMinor: 50000,
        },
        testDb,
      ),
    ).rejects.toBeInstanceOf(TemplateNotEligibleError);

    const pledges = await testDb.select().from(computePledges);
    expect(pledges).toHaveLength(0);
  });

  it('refuses every category outside the template allow-list', async () => {
    const { charity, corp } = await twoOrgs();
    for (const category of ['construction', 'fundraising', 'events', 'research', 'legal']) {
      const projectId = await publishedProject(charity, category);
      await expect(
        fundComputeBudget(
          corp.userId,
          projectId,
          {
            corporationOrgId: corp.organisationId,
            templateCode: 'static-site',
            budgetMinor: 50000,
          },
          testDb,
        ),
      ).rejects.toBeInstanceOf(TemplateNotEligibleError);
    }
    expect(await testDb.select().from(computePledges)).toHaveLength(0);
  });

  it('rejects a template code that is not on the allow-list at all, at the schema', async () => {
    const { charity, corp } = await twoOrgs();
    const projectId = await publishedProject(charity, 'software');

    await expect(
      fundComputeBudget(
        corp.userId,
        projectId,
        {
          corporationOrgId: corp.organisationId,
          // Not in the registry — the derived zod enum refuses it.
          templateCode: 'mobile-app',
          budgetMinor: 50000,
        } as unknown as Parameters<typeof fundComputeBudget>[2],
        testDb,
      ),
    ).rejects.toThrow();
    expect(await testDb.select().from(computePledges)).toHaveLength(0);
  });
});
