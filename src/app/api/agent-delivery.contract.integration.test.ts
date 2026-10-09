import { describe, it, expect, vi, beforeEach } from 'vitest';

// Mock only the framework cookie boundary; real auth (verifySession) runs on top.
let cookieValue: string | undefined;
vi.mock('next/headers', () => ({
  cookies: async () => ({
    get: (name: string) => (cookieValue ? { name, value: cookieValue } : undefined),
  }),
}));

import { signSession, newSession } from '@/lib/session';
import {
  registerCharity,
  registerCorporation,
  approveVerification,
  createPlatformAdmin,
  inviteMember,
} from '@/modules/identity';
import { createDraftProject, setResourceNeeds, publishProject } from '@/modules/projects';
import { runCurrentPhase } from '@/modules/agent-delivery';
import { FakeModelProvider } from '@/lib/fake-model-provider';

import { POST as fundRoute } from './projects/[id]/compute-pledges/route';
import { POST as acceptPledgeRoute } from './compute-pledges/[id]/accept/route';
import { POST as approveRoute } from './agent-milestones/[id]/approve/route';
import { POST as runStatusRoute } from './admin/runs/[id]/status/route';
import { POST as brakeRoute } from './admin/agent-delivery/brake/route';
import { POST as promoteRoute } from './runs/[id]/promote/route';
import { promotableRun } from '@/test/agent-delivery-fixtures';
import { GET as adminTemplatesRoute } from './admin/agent-delivery/templates/route';

function authAs(userId: string, isPlatformAdmin = false) {
  cookieValue = signSession(newSession(userId, isPlatformAdmin));
}
function signOut() {
  cookieValue = undefined;
}
function jsonReq(body: unknown) {
  return new Request('http://localhost/api', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  });
}
const params = (id: string) => ({ params: Promise.resolve({ id }) });

const need = {
  skill: 'Backend',
  role: 'Dev',
  kind: 'ongoing' as const,
  quantity: 1,
  hoursPerWeek: 2,
  durationWeeks: 8,
};

beforeEach(() => signOut());

async function fundedPublishedProject() {
  const admin = await createPlatformAdmin('agentadmin@hodorhub.com', 'admin-password-1');
  const charity = await registerCharity({
    email: 'petra@agentcause.org',
    password: 'a-strong-password',
    charityName: 'Agent Cause',
    regNumber: 'CH-AGENT-1',
  });
  const corp = await registerCorporation({
    email: 'carlos@agentco.com',
    password: 'a-strong-password',
    companyName: 'AgentCo',
    emailDomain: 'agentco.com',
  });
  await approveVerification(charity.verificationRequestId, admin);
  await approveVerification(corp.verificationRequestId, admin);
  const project = await createDraftProject(charity.userId, {
    charityOrgId: charity.organisationId,
    title: 'Agent-delivered site',
    description: 'A worthy community cause that needs a hand from local people.',
    goal: 'Ship the site.',
    category: 'software',
  });
  await setResourceNeeds(charity.userId, project.projectId, [need]);
  await publishProject(charity.userId, project.projectId);
  return { admin, charity, corp, projectId: project.projectId };
}

describe('API contract — agent delivery (compute pledges + milestones)', () => {
  it('POST /projects/[id]/compute-pledges without a session → 401', async () => {
    const { projectId } = await fundedPublishedProject();
    signOut();
    const res = await fundRoute(
      jsonReq({
        corporationOrgId: crypto.randomUUID(),
        templateCode: 'static-site',
        budgetMinor: 5000,
      }),
      params(projectId),
    );
    expect(res.status).toBe(401);
  });

  it('a charity (not a corp csr_manager) funding → 403', async () => {
    const { charity, projectId } = await fundedPublishedProject();
    authAs(charity.userId);
    const res = await fundRoute(
      jsonReq({
        corporationOrgId: charity.organisationId,
        templateCode: 'static-site',
        budgetMinor: 5000,
      }),
      params(projectId),
    );
    expect(res.status).toBe(403);
  });

  it('a corp csr_manager funds a published project → 200 with a computePledgeId', async () => {
    const { corp, projectId } = await fundedPublishedProject();
    authAs(corp.userId);
    const res = await fundRoute(
      jsonReq({
        corporationOrgId: corp.organisationId,
        templateCode: 'static-site',
        budgetMinor: 5000,
      }),
      params(projectId),
    );
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(typeof body.computePledgeId).toBe('string');
  });

  it('the charity accepts a compute pledge → 200', async () => {
    const { charity, corp, projectId } = await fundedPublishedProject();
    authAs(corp.userId);
    const fundRes = await fundRoute(
      jsonReq({
        corporationOrgId: corp.organisationId,
        templateCode: 'static-site',
        budgetMinor: 5000,
      }),
      params(projectId),
    );
    const { computePledgeId } = await fundRes.json();

    authAs(charity.userId);
    const res = await acceptPledgeRoute(jsonReq({}), params(computePledgeId));
    expect(res.status).toBe(200);
    expect(typeof (await res.json()).runId).toBe('string');
  });

  it('drives a requirements milestone then approves it via the approve route → 200; wrong role → 403', async () => {
    const { charity, corp, projectId } = await fundedPublishedProject();
    authAs(corp.userId);
    const fundRes = await fundRoute(
      jsonReq({
        corporationOrgId: corp.organisationId,
        templateCode: 'static-site',
        budgetMinor: 20000,
      }),
      params(projectId),
    );
    const { computePledgeId } = await fundRes.json();

    authAs(charity.userId);
    const acceptRes = await acceptPledgeRoute(jsonReq({}), params(computePledgeId));
    const { runId } = await acceptRes.json();

    const provider = new FakeModelProvider([
      { text: 'GIVEN a visitor WHEN they open the site THEN they see the mission' },
    ]);
    const { milestoneId } = await runCurrentPhase(runId, provider);

    // wrong role: a volunteer member of the charity org (not the charity_owner) cannot approve
    const { userId: volunteerId } = await inviteMember(
      charity.userId,
      charity.organisationId,
      'volunteer@agentcause.org',
      'volunteer',
    );
    authAs(volunteerId);
    const forbidden = await approveRoute(jsonReq({}), params(milestoneId));
    expect(forbidden.status).toBe(403);

    authAs(charity.userId);
    const res = await approveRoute(jsonReq({}), params(milestoneId));
    expect(res.status).toBe(200);
    expect((await res.json()).status).toBe('approved');
  });
});

/**
 * The file's fundedPublishedProject() publishes a project but does NOT fund it
 * and returns no runId, so drive fund → accept through the routes to get one,
 * exactly as the accept-route test above does. Do not modify that helper.
 */
async function runViaRoutes() {
  const { admin, charity, corp, projectId } = await fundedPublishedProject();
  authAs(corp.userId);
  const fundRes = await fundRoute(
    jsonReq({
      corporationOrgId: corp.organisationId,
      templateCode: 'static-site',
      budgetMinor: 5000,
    }),
    params(projectId),
  );
  const { computePledgeId } = await fundRes.json();
  authAs(charity.userId);
  const acceptRes = await acceptPledgeRoute(jsonReq({}), params(computePledgeId));
  const { runId } = await acceptRes.json();
  return { admin, charity, corp, runId };
}

describe('admin run controls (US-11.5)', () => {
  it('lets a platform admin pause a run', async () => {
    const { runId, admin } = await runViaRoutes();
    authAs(admin, true);
    const res = await runStatusRoute(jsonReq({ status: 'paused' }), params(runId));
    expect(res.status).toBe(200);
    await expect(res.json()).resolves.toMatchObject({ ok: true, status: 'paused' });
  });

  it('refuses a non-admin with 403', async () => {
    const { runId, charity } = await runViaRoutes();
    authAs(charity.userId);
    const res = await runStatusRoute(jsonReq({ status: 'halted' }), params(runId));
    expect(res.status).toBe(403);
  });

  it('rejects a status outside the admin-settable set with 400', async () => {
    const { runId, admin } = await runViaRoutes();
    authAs(admin, true);
    const res = await runStatusRoute(jsonReq({ status: 'completed' }), params(runId));
    expect(res.status).toBe(400);
  });

  it('returns 409 when the run is already terminal', async () => {
    const { runId, admin } = await runViaRoutes();
    authAs(admin, true);
    await runStatusRoute(jsonReq({ status: 'halted' }), params(runId));
    const res = await runStatusRoute(jsonReq({ status: 'paused' }), params(runId));
    expect(res.status).toBe(409);
  });

  it('returns 404 for an unknown run', async () => {
    const { admin } = await runViaRoutes();
    authAs(admin, true);
    const res = await runStatusRoute(
      jsonReq({ status: 'paused' }),
      params('11111111-1111-1111-1111-111111111111'),
    );
    expect(res.status).toBe(404);
  });

  it('lets a platform admin pull and release the platform brake', async () => {
    const { admin } = await runViaRoutes();
    authAs(admin, true);
    const on = await brakeRoute(jsonReq({ paused: true }));
    expect(on.status).toBe(200);
    await expect(on.json()).resolves.toMatchObject({ ok: true, agentDeliveryPaused: true });
    const off = await brakeRoute(jsonReq({ paused: false }));
    expect(off.status).toBe(200);
    await expect(off.json()).resolves.toMatchObject({ agentDeliveryPaused: false });
  });

  it('refuses the platform brake to a non-admin with 403', async () => {
    const { charity } = await runViaRoutes();
    authAs(charity.userId);
    const res = await brakeRoute(jsonReq({ paused: true }));
    expect(res.status).toBe(403);
  });

  it('rejects a malformed brake body with 400', async () => {
    const { admin } = await runViaRoutes();
    authAs(admin, true);
    const res = await brakeRoute(jsonReq({ paused: 'yes' }));
    expect(res.status).toBe(400);
  });
});

/**
 * US-11.8 — the promotion gate over HTTP. Uses the shared promotableRun()
 * fixture (an approved app on live staging) rather than driving the phases
 * through routes again: the gate, not the road to it, is what is under test.
 */
describe('production promotion gate (US-11.8)', () => {
  it('lets the charity owner approve promotion', async () => {
    const { charity, runId } = await promotableRun();
    authAs(charity.userId);
    const res = await promoteRoute(jsonReq({}), params(runId));
    expect(res.status).toBe(200);
    await expect(res.json()).resolves.toMatchObject({ ok: true, status: 'deploying' });
  });

  it('refuses an anonymous caller with 401', async () => {
    const { runId } = await promotableRun();
    signOut();
    const res = await promoteRoute(jsonReq({}), params(runId));
    expect(res.status).toBe(401);
  });

  it('hides the run from the funding corporation with 404', async () => {
    const { corp, runId } = await promotableRun();
    authAs(corp.userId);
    const res = await promoteRoute(jsonReq({}), params(runId));
    expect(res.status).toBe(404);
  });

  it('refuses a platform admin with 404 — promotion is the charity decision', async () => {
    const { admin, runId } = await promotableRun();
    authAs(admin, true);
    const res = await promoteRoute(jsonReq({}), params(runId));
    expect(res.status).toBe(404);
  });

  it('returns 409 for a second approval while one is in flight', async () => {
    const { charity, runId } = await promotableRun();
    authAs(charity.userId);
    await promoteRoute(jsonReq({}), params(runId));
    const res = await promoteRoute(jsonReq({}), params(runId));
    expect(res.status).toBe(409);
  });

  it('returns 404 for an unknown run', async () => {
    const { charity } = await promotableRun();
    authAs(charity.userId);
    const res = await promoteRoute(jsonReq({}), params('11111111-1111-1111-1111-111111111111'));
    expect(res.status).toBe(404);
  });
});

/**
 * US-11.12 — the allow-list over HTTP. The gate is about the PROJECT: an
 * ineligible shape is 422 (well-formed request, wrong shape), while a template
 * code that is not on the list at all fails the derived zod enum as a 400.
 */
describe('eligible-template scope (US-11.12)', () => {
  async function publishedProjectOfCategory(category: string) {
    const { admin, charity, corp } = await fundedPublishedProject();
    const project = await createDraftProject(charity.userId, {
      charityOrgId: charity.organisationId,
      title: `A ${category} appeal`,
      description: 'A worthy community cause that needs a hand from local people.',
      goal: 'Get it done.',
      category,
    } as Parameters<typeof createDraftProject>[1]);
    await setResourceNeeds(charity.userId, project.projectId, [need]);
    await publishProject(charity.userId, project.projectId);
    return { admin, charity, corp, projectId: project.projectId };
  }

  it('funds an eligible project shape → 200', async () => {
    const { corp, projectId } = await publishedProjectOfCategory('software');
    authAs(corp.userId);
    const res = await fundRoute(
      jsonReq({
        corporationOrgId: corp.organisationId,
        templateCode: 'static-site',
        budgetMinor: 5000,
      }),
      params(projectId),
    );
    expect(res.status).toBe(200);
  });

  it('refuses an ineligible project shape → 422', async () => {
    const { corp, projectId } = await publishedProjectOfCategory('construction');
    authAs(corp.userId);
    const res = await fundRoute(
      jsonReq({
        corporationOrgId: corp.organisationId,
        templateCode: 'static-site',
        budgetMinor: 5000,
      }),
      params(projectId),
    );
    expect(res.status).toBe(422);
    await expect(res.json()).resolves.toMatchObject({ error: 'template_not_eligible' });
  });

  it('refuses a template code that is not on the allow-list → 400', async () => {
    const { corp, projectId } = await publishedProjectOfCategory('software');
    authAs(corp.userId);
    const res = await fundRoute(
      jsonReq({
        corporationOrgId: corp.organisationId,
        templateCode: 'mobile-app',
        budgetMinor: 5000,
      }),
      params(projectId),
    );
    expect(res.status).toBe(400);
  });

  it('shows a platform admin the allow-list and its eval evidence', async () => {
    const { admin } = await publishedProjectOfCategory('software');
    authAs(admin, true);
    const res = await adminTemplatesRoute();
    expect(res.status).toBe(200);
    const body = (await res.json()) as { templates: { code: string; provenBy: string }[] };
    expect(body.templates.map((t) => t.code)).toContain('static-site');
    expect(body.templates[0]!.provenBy).toBeTruthy();
  });

  it('refuses the allow-list view to a non-admin → 403', async () => {
    const { corp } = await publishedProjectOfCategory('software');
    authAs(corp.userId);
    const res = await adminTemplatesRoute();
    expect(res.status).toBe(403);
  });
});
