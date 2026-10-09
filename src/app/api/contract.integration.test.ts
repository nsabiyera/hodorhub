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
} from '@/modules/identity';
import { db } from '@/db';
import { eq } from 'drizzle-orm';
import { entitlements, outbox } from '@/db/schema';
import { FEATURES } from '@/modules/monetisation';

/** US-10.5 — grant the dashboard entitlement without a subscription row. */
async function grantDashboard(organisationId: string) {
  await db.insert(entitlements).values({ organisationId, feature: FEATURES.csrDashboard });
}
import {
  createDraftProject,
  setResourceNeeds,
  publishProject,
  transitionProjectStatus,
} from '@/modules/projects';
import { pledgeResources, acceptPledge, expressInterest } from '@/modules/commitments';

import { POST as registerCharityRoute } from './register/charity/route';
import { POST as registerCorpRoute } from './register/corporation/route';
import { POST as createProjectRoute } from './projects/route';
import { POST as publishRoute } from './projects/[id]/publish/route';
import { POST as supportRoute } from './projects/[id]/support/route';
import { POST as completeRoute } from './projects/[id]/complete/route';
import { POST as transitionRoute } from './projects/[id]/transition/route';
import { GET as impactRoute } from './projects/[id]/impact/route';
import { GET as orgImpactRoute } from './organisations/[id]/impact/route';
import { GET as adminVerificationsRoute } from './admin/verifications/route';
import { GET as boardRoute } from './workspaces/[id]/route';
import { POST as wsTaskRoute } from './workspaces/[id]/tasks/route';
import { POST as wsMilestoneRoute } from './workspaces/[id]/milestones/route';
import { PATCH as patchTaskRoute } from './tasks/[id]/route';
import { POST as achieveMilestoneRoute } from './milestones/[id]/achieve/route';
import { GET as progressRoute } from './projects/[id]/progress/route';
import { GET as prefsGetRoute, PUT as prefsPutRoute } from './notification-preferences/route';
import { POST as postMessageRoute } from './projects/[id]/messages/route';
import { GET as conversationsRoute } from './projects/[id]/conversations/route';
import { GET as threadRoute } from './threads/[id]/route';

function authAs(userId: string, isPlatformAdmin = false) {
  cookieValue = signSession(newSession(userId, isPlatformAdmin));
}
function signOut() {
  cookieValue = undefined;
}
function jsonReq(body: unknown, ip = 'test-ip') {
  return new Request('http://localhost/api', {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'x-forwarded-for': ip },
    body: JSON.stringify(body),
  });
}
const params = (id: string) => ({ params: Promise.resolve({ id }) });

const need = {
  skill: 'Landscaping',
  role: 'Gardener',
  kind: 'ongoing' as const,
  quantity: 1,
  hoursPerWeek: 2,
  durationWeeks: 8,
};

beforeEach(() => signOut());

describe('API contract — registration', () => {
  it('POST /register/charity → 201 pending', async () => {
    const res = await registerCharityRoute(
      jsonReq(
        {
          email: 'a@charity.org',
          password: 'a-strong-password',
          charityName: 'A Charity',
          regNumber: 'CH-1',
        },
        'ip-1',
      ),
    );
    expect(res.status).toBe(201);
    expect((await res.json()).status).toBe('pending');
  });

  it('POST /register/corporation with off-domain email → 422', async () => {
    const res = await registerCorpRoute(
      jsonReq(
        {
          email: 'x@gmail.com',
          password: 'a-strong-password',
          companyName: 'Acme',
          emailDomain: 'acme.com',
        },
        'ip-2',
      ),
    );
    expect(res.status).toBe(422);
    expect((await res.json()).error).toBe('invalid_work_email');
  });

  it('POST /register/charity with invalid body → 400 validation', async () => {
    const res = await registerCharityRoute(jsonReq({ email: 'nope' }, 'ip-3'));
    expect(res.status).toBe(400);
    expect((await res.json()).error).toBe('validation');
  });

  it('rate-limits registration from one IP → 429', async () => {
    const hammer = 'ip-flood';
    let sawLimit = false;
    for (let i = 0; i < 7; i += 1) {
      const res = await registerCharityRoute(
        jsonReq(
          {
            email: `f${i}@c.org`,
            password: 'a-strong-password',
            charityName: 'Flood',
            regNumber: `CH-F${i}`,
          },
          hammer,
        ),
      );
      if (res.status === 429) sawLimit = true;
    }
    expect(sawLimit).toBe(true); // limiter is 5/min/IP
  });
});

describe('API contract — auth guards', () => {
  it('POST /projects without a session → 401', async () => {
    signOut();
    const res = await createProjectRoute(
      jsonReq({ charityOrgId: crypto.randomUUID(), title: 'X' }),
    );
    expect(res.status).toBe(401);
  });

  it('GET /admin/verifications as a non-admin → 403', async () => {
    const r = await registerCharity({
      email: 'owner@c.org',
      password: 'a-strong-password',
      charityName: 'Owner Charity',
      regNumber: 'CH-9',
    });
    authAs(r.userId, false); // not a platform admin
    const res = await adminVerificationsRoute();
    expect(res.status).toBe(403);
  });

  it('GET /admin/verifications as an admin → 200', async () => {
    const adminId = await createPlatformAdmin('boss@hodorhub.com', 'admin-password-1');
    authAs(adminId, true);
    const res = await adminVerificationsRoute();
    expect(res.status).toBe(200);
    expect(Array.isArray((await res.json()).pending)).toBe(true);
  });
});

describe('API contract — project publish flow', () => {
  it('blocks publish for an unverified charity → 403 not_verified, then 200 once verified', async () => {
    const owner = await registerCharity({
      email: 'petra@rg.org',
      password: 'a-strong-password',
      charityName: 'RG',
      regNumber: 'CH-3',
    });
    const { projectId } = await createDraftProject(owner.userId, {
      charityOrgId: owner.organisationId,
      title: 'Restore the garden',
      description: 'A worthy community cause that needs a hand from local people.',
      goal: 'Reopen by spring.',
      category: 'software',
    });
    await setResourceNeeds(owner.userId, projectId, [need]);

    authAs(owner.userId);
    const blocked = await publishRoute(jsonReq({}), params(projectId));
    expect(blocked.status).toBe(403);
    expect((await blocked.json()).error).toBe('not_verified');

    const adminId = await createPlatformAdmin('admin2@hodorhub.com', 'admin-password-1');
    await approveVerification(owner.verificationRequestId, adminId);

    const ok = await publishRoute(jsonReq({}), params(projectId));
    expect(ok.status).toBe(200);
    expect((await ok.json()).status).toBe('published');
  });
});

describe('API contract — support', () => {
  it('requires auth (401) then supports (200)', async () => {
    // seed a published project
    const owner = await registerCharity({
      email: 'petra2@rg.org',
      password: 'a-strong-password',
      charityName: 'RG2',
      regNumber: 'CH-4',
    });
    const adminId = await createPlatformAdmin('admin3@hodorhub.com', 'admin-password-1');
    await approveVerification(owner.verificationRequestId, adminId);
    const { projectId } = await createDraftProject(owner.userId, {
      charityOrgId: owner.organisationId,
      title: 'Support me',
      description: 'A worthy community cause that needs a hand from local people.',
      goal: 'Reopen by spring.',
      category: 'software',
    });
    await setResourceNeeds(owner.userId, projectId, [need]);
    const { publishProject } = await import('@/modules/projects');
    await publishProject(owner.userId, projectId);

    signOut();
    expect((await supportRoute(jsonReq({}), params(projectId))).status).toBe(401);

    authAs(adminId);
    const res = await supportRoute(jsonReq({}), params(projectId));
    expect(res.status).toBe(200);
    expect((await res.json()).supportCount).toBe(1);
  });
});

/** A published project moved into delivery, owned by a fresh verified charity. */
async function inDeliveryProject() {
  const charity = await registerCharity({
    email: 'petra@outcome.org',
    password: 'a-strong-password',
    charityName: 'Outcome Cause',
    regNumber: 'CH-OUT-1',
  });
  const admin = await createPlatformAdmin('outcomeadmin@hodorhub.com', 'admin-password-1');
  await approveVerification(charity.verificationRequestId, admin);
  const project = await createDraftProject(charity.userId, {
    charityOrgId: charity.organisationId,
    title: 'Outcome project',
    description: 'A worthy community cause that needs a hand from local people.',
    goal: 'Get it done.',
    category: 'software',
  });
  await setResourceNeeds(charity.userId, project.projectId, [need]);
  await publishProject(charity.userId, project.projectId);
  await transitionProjectStatus(charity.userId, project.projectId, 'in_delivery');
  return { charity, projectId: project.projectId };
}

/**
 * US-7.3 — completion over HTTP. The contract that matters is that there is
 * exactly ONE way to reach 'completed', and it carries an outcome story.
 */
describe('API contract — project completion (US-7.3)', () => {
  const STORY = 'The site launched in March and 400 local volunteers signed up in the first month.';

  it('completes with an outcome story → 200', async () => {
    const { charity, projectId } = await inDeliveryProject();
    authAs(charity.userId);
    const res = await completeRoute(jsonReq({ outcomeStory: STORY }), params(projectId));
    expect(res.status).toBe(200);
    await expect(res.json()).resolves.toMatchObject({ ok: true, status: 'completed' });
  });

  it('refuses a too-short outcome story → 400', async () => {
    const { charity, projectId } = await inDeliveryProject();
    authAs(charity.userId);
    const res = await completeRoute(jsonReq({ outcomeStory: 'Done.' }), params(projectId));
    expect(res.status).toBe(400);
  });

  it('refuses an anonymous caller → 401', async () => {
    const { projectId } = await inDeliveryProject();
    signOut();
    const res = await completeRoute(jsonReq({ outcomeStory: STORY }), params(projectId));
    expect(res.status).toBe(401);
  });

  it('no longer accepts completed through the generic transition route → 400', async () => {
    const { charity, projectId } = await inDeliveryProject();
    authAs(charity.userId);
    const res = await transitionRoute(jsonReq({ to: 'completed' }), params(projectId));
    expect(res.status).toBe(400);
  });
});

/** US-7.2 — the impact summary is owner-only, and invisible to everyone else. */
describe('API contract — charity impact summary (US-7.2)', () => {
  it('returns the summary to the owning charity → 200', async () => {
    const { charity, projectId } = await inDeliveryProject();
    authAs(charity.userId);
    const res = await impactRoute(new Request('http://localhost/api'), params(projectId));
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      hours: { approvedHours: number; pendingHours: number };
      support: { supporterCount: number };
    };
    // Approved and pending arrive as separate figures, never pre-summed.
    expect(body.hours).toHaveProperty('approvedHours');
    expect(body.hours).toHaveProperty('pendingHours');
    expect(body.support).toHaveProperty('supporterCount');
  });

  it('refuses an anonymous caller → 401', async () => {
    const { projectId } = await inDeliveryProject();
    signOut();
    const res = await impactRoute(new Request('http://localhost/api'), params(projectId));
    expect(res.status).toBe(401);
  });

  it('hides another charity project → 404', async () => {
    const { projectId } = await inDeliveryProject();
    const outsider = await registerCharity({
      email: 'nosy@other.org',
      password: 'a-strong-password',
      charityName: 'Other Cause',
      regNumber: 'CH-OTHER-9',
    });
    authAs(outsider.userId);
    const res = await impactRoute(new Request('http://localhost/api'), params(projectId));
    expect(res.status).toBe(404);
  });
});

/** US-10.5 — a gated feature answers with billing, not permission. */
describe('API contract — plan gating (US-10.5)', () => {
  it('a Starter corporation gets 402 with the plan that unlocks it', async () => {
    const corp = await registerCorporation({
      email: 'gate@gateco.com',
      password: 'a-strong-password',
      companyName: 'GateCo',
      emailDomain: 'gateco.com',
    });
    authAs(corp.userId);

    const res = await orgImpactRoute(
      new Request('http://localhost/api'),
      params(corp.organisationId),
    );

    expect(res.status).toBe(402);
    await expect(res.json()).resolves.toMatchObject({ error: 'upgrade_required' });
  });

  it('the same corporation gets 200 once entitled', async () => {
    const corp = await registerCorporation({
      email: 'gate2@gateco2.com',
      password: 'a-strong-password',
      companyName: 'GateCo Two',
      emailDomain: 'gateco2.com',
    });
    await grantDashboard(corp.organisationId);
    authAs(corp.userId);

    const res = await orgImpactRoute(
      new Request('http://localhost/api'),
      params(corp.organisationId),
    );

    expect(res.status).toBe(200);
  });
});

/**
 * US-6.3 / US-6.4 over HTTP. The statuses are the contract: an outsider gets
 * 404 (never 403, which would confirm the workspace exists), a wrong-role
 * participant gets 403, and a cross-workspace reference gets 409.
 */
describe('API contract — delivery workspace (US-6.3/6.4)', () => {
  async function acceptedWorkspace() {
    const charity = await registerCharity({
      email: 'petra@wsboard.org',
      password: 'a-strong-password',
      charityName: 'Workspace Cause',
      regNumber: 'CH-WS-1',
    });
    const admin = await createPlatformAdmin('wsadmin@hodorhub.com', 'admin-password-1');
    await approveVerification(charity.verificationRequestId, admin);
    const project = await createDraftProject(charity.userId, {
      charityOrgId: charity.organisationId,
      title: 'Workspace project',
      description: 'A worthy community cause that needs a hand from local people.',
      goal: 'Reopen the garden by spring.',
      category: 'software',
    });
    await setResourceNeeds(charity.userId, project.projectId, [need]);
    await publishProject(charity.userId, project.projectId);
    const corp = await registerCorporation({
      email: 'carlos@wsacme.com',
      password: 'a-strong-password',
      companyName: 'WS Acme',
      emailDomain: 'wsacme.com',
    });
    const { pledgeId } = await pledgeResources(corp.userId, project.projectId, {
      corporationOrgId: corp.organisationId,
      resourceType: 'Dev time',
      quantity: 2,
      durationWeeks: 8,
    });
    const { deliveryWorkspaceId } = await acceptPledge(charity.userId, pledgeId);
    return { charity, corp, admin, projectId: project.projectId, workspaceId: deliveryWorkspaceId };
  }

  it('serves the shared board to both sides and 404s everyone else', async () => {
    const { charity, corp, admin, workspaceId } = await acceptedWorkspace();

    authAs(charity.userId);
    expect(
      (await boardRoute(new Request('http://localhost/api'), params(workspaceId))).status,
    ).toBe(200);
    authAs(corp.userId);
    expect(
      (await boardRoute(new Request('http://localhost/api'), params(workspaceId))).status,
    ).toBe(200);

    // A platform admin is not a participant — 404, not 403.
    authAs(admin, true);
    expect(
      (await boardRoute(new Request('http://localhost/api'), params(workspaceId))).status,
    ).toBe(404);
    signOut();
    expect(
      (await boardRoute(new Request('http://localhost/api'), params(workspaceId))).status,
    ).toBe(401);
  });

  it('gives the corporation 403 on milestones and 201 on tasks', async () => {
    const { charity, corp, workspaceId } = await acceptedWorkspace();

    authAs(corp.userId);
    const refused = await wsMilestoneRoute(jsonReq({ title: 'Phase one' }), params(workspaceId));
    expect(refused.status).toBe(403);

    authAs(charity.userId);
    const created = await wsMilestoneRoute(
      jsonReq({ title: 'Phase one', dueOn: '2026-12-01' }),
      params(workspaceId),
    );
    expect(created.status).toBe(201);
    const { milestoneId } = (await created.json()) as { milestoneId: string };

    authAs(corp.userId);
    const task = await wsTaskRoute(
      jsonReq({ title: 'Set up the repo', milestoneId }),
      params(workspaceId),
    );
    expect(task.status).toBe(201);
    const { taskId } = (await task.json()) as { taskId: string };

    const moved = await patchTaskRoute(
      new Request('http://localhost/api', {
        method: 'PATCH',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ status: 'done' }),
      }),
      params(taskId),
    );
    expect(moved.status).toBe(200);

    // The corporation finished the work but cannot confirm the milestone.
    const selfConfirm = await achieveMilestoneRoute(
      new Request('http://localhost/api', { method: 'POST' }),
      params(milestoneId),
    );
    expect(selfConfirm.status).toBe(403);

    authAs(charity.userId);
    const confirmed = await achieveMilestoneRoute(
      new Request('http://localhost/api', { method: 'POST' }),
      params(milestoneId),
    );
    expect(confirmed.status).toBe(200);
    // Twice is a conflict.
    const again = await achieveMilestoneRoute(
      new Request('http://localhost/api', { method: 'POST' }),
      params(milestoneId),
    );
    expect(again.status).toBe(409);
  });

  it('rejects a malformed due date as 400 and a foreign allocation as 409', async () => {
    const { charity, workspaceId } = await acceptedWorkspace();
    authAs(charity.userId);
    const badDate = await wsMilestoneRoute(
      jsonReq({ title: 'Phase one', dueOn: '01/12/2026' }),
      params(workspaceId),
    );
    expect(badDate.status).toBe(400);

    // A well-formed uuid that is not an allocation on this workspace: the body
    // is valid, the reference is not → 409 invalid_state, not 400.
    const foreign = await wsTaskRoute(
      jsonReq({
        title: 'Borrowed hands',
        assignedAllocationId: '00000000-0000-0000-0000-0000000000ff',
      }),
      params(workspaceId),
    );
    expect(foreign.status).toBe(409);
  });

  it('serves progress to the charity owner only', async () => {
    const { charity, corp, projectId } = await acceptedWorkspace();
    authAs(charity.userId);
    const res = await progressRoute(new Request('http://localhost/api'), params(projectId));
    expect(res.status).toBe(200);
    const body = (await res.json()) as { inDelivery: boolean; goal: string; effort: unknown };
    expect(body.inDelivery).toBe(true);
    expect(body.goal).toBe('Reopen the garden by spring.');
    // Three figures, never one.
    expect(body.effort).toMatchObject({
      allocatedHoursPerWeek: 0,
      approvedHours: 0,
      pendingHours: 0,
    });

    authAs(corp.userId);
    expect(
      (await progressRoute(new Request('http://localhost/api'), params(projectId))).status,
    ).toBe(404);
  });
});

// US-8.2 — the preferences route carries the story's authorisation criterion
// ("anyone else's preferences … I cannot"), so it is pinned here rather than
// resting on a manual session.
describe('Notification preferences route (US-8.2)', () => {
  async function aUser(tag: string) {
    return registerCharity({
      email: `prefs-${tag}@goodcause.org`,
      password: 'a-strong-password',
      charityName: `Prefs Cause ${tag}`,
      regNumber: `CH-PREFS-${tag}`,
    });
  }
  const putReq = (body: unknown) =>
    new Request('http://localhost/api/notification-preferences', {
      method: 'PUT',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(body),
    });

  it('requires a session to read or write', async () => {
    signOut();
    expect((await prefsGetRoute()).status).toBe(401);
    expect(
      (await prefsPutRoute(putReq({ kind: 'gifts', inApp: false, email: false }))).status,
    ).toBe(401);
  });

  it('rejects a kind that is not in the registry', async () => {
    const user = await aUser('a');
    authAs(user.userId);
    const res = await prefsPutRoute(putReq({ kind: 'nonsense', inApp: true, email: true }));
    expect(res.status).toBe(400);
    expect((await res.json()).error).toBe('validation');
  });

  it('refuses to silence an essential kind in-app, with 422 not 403', async () => {
    const user = await aUser('b');
    authAs(user.userId);
    const res = await prefsPutRoute(putReq({ kind: 'verification', inApp: false, email: true }));
    expect(res.status).toBe(422);
    expect((await res.json()).error).toBe('preference_locked');
    // Its email is still the user's to turn off.
    expect(
      (await prefsPutRoute(putReq({ kind: 'verification', inApp: true, email: false }))).status,
    ).toBe(200);
  });

  it('only ever reads and writes the signed-in user’s own preferences', async () => {
    const mine = await aUser('c');
    const yours = await aUser('d');

    authAs(mine.userId);
    expect(
      (await prefsPutRoute(putReq({ kind: 'gifts', inApp: false, email: false }))).status,
    ).toBe(200);

    // There is no user id anywhere in the request, so the only way to reach
    // another account would be a body field the schema honoured. It does not.
    authAs(yours.userId);
    const spoof = await prefsPutRoute(
      putReq({ userId: mine.userId, kind: 'gifts', inApp: true, email: true }),
    );
    expect(spoof.status).toBe(200);

    // Mine is untouched by yours, and each side reads only its own.
    authAs(mine.userId);
    const mineBody = (await (await prefsGetRoute()).json()) as {
      kinds: { code: string; inApp: boolean; email: boolean }[];
    };
    expect(mineBody.kinds.find((k) => k.code === 'gifts')).toMatchObject({
      inApp: false,
      email: false,
    });
  });
});

// US-8.3 — the messaging routes. The rate limit and the 403/404 split are HTTP
// concerns that the domain tests cannot see, so they are pinned here.
describe('Messaging routes (US-8.3)', () => {
  async function related() {
    const charity = await registerCharity({
      email: 'petra-msg@goodcause.org',
      password: 'a-strong-password',
      charityName: 'Msg Cause',
      regNumber: 'CH-MSG',
    });
    const admin = await createPlatformAdmin('msgadmin@hodorhub.com', 'admin-password-1');
    await approveVerification(charity.verificationRequestId, admin);
    const project = await createDraftProject(charity.userId, {
      charityOrgId: charity.organisationId,
      title: 'Msg project',
      description: 'A worthy community cause that needs a hand from local people.',
      goal: 'Get it done.',
      category: 'software',
    });
    await setResourceNeeds(charity.userId, project.projectId, [need]);
    await publishProject(charity.userId, project.projectId);

    const corp = await registerCorporation({
      email: 'carlos-msg@acmemsg.com',
      password: 'another-strong-pw',
      companyName: 'Acme Msg',
      emailDomain: 'acmemsg.com',
    });
    await approveVerification(corp.verificationRequestId, admin);
    return { charity, corp, admin, projectId: project.projectId };
  }

  const body = (b: unknown) =>
    new Request('http://localhost/api', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(b),
    });

  it('needs a session', async () => {
    signOut();
    expect(
      (await conversationsRoute(new Request('http://localhost/api'), params('x'))).status,
    ).toBe(401);
    expect((await postMessageRoute(body({}), params('x'))).status).toBe(401);
    // The thread route is the one that returns message content, so its 401
    // matters most of the three.
    expect((await threadRoute(new Request('http://localhost/api'), params('x'))).status).toBe(401);
  });

  it('answers 400, not 500, for a nonsense pagination cursor', async () => {
    const { corp, projectId } = await related();
    await expressInterest(corp.userId, projectId, corp.organisationId);
    authAs(corp.userId);
    const posted = await postMessageRoute(
      body({ corporationOrgId: corp.organisationId, body: 'One message' }),
      params(projectId),
    );
    const { threadId } = (await posted.json()) as { threadId: string };

    // `seq` is a bigint column; a fractional cursor reaches Postgres as
    // invalid text, which used to surface as an unhandled 500.
    const res = await threadRoute(
      new Request('http://localhost/api/threads/x?before=1.5'),
      params(threadId),
    );
    expect(res.status).toBe(400);
    expect((await res.json()).error).toBe('invalid_cursor');
  });

  it('answers 403 no_relationship, not 404, for a corporation with no tie to the project', async () => {
    const { corp, projectId } = await related();
    authAs(corp.userId);
    const res = await postMessageRoute(
      body({ corporationOrgId: corp.organisationId, body: 'Let me in' }),
      params(projectId),
    );
    // 403 rather than 404: they can already see this public project, so hiding
    // it would only cost them the prompt telling them how to start talking.
    expect(res.status).toBe(403);
    expect((await res.json()).error).toBe('no_relationship');
  });

  it('posts, then serves the thread to both sides and 404s everyone else', async () => {
    const { charity, corp, admin, projectId } = await related();
    await expressInterest(corp.userId, projectId, corp.organisationId);

    authAs(corp.userId);
    const posted = await postMessageRoute(
      body({ corporationOrgId: corp.organisationId, body: 'Hello there' }),
      params(projectId),
    );
    expect(posted.status).toBe(201);
    const { threadId } = (await posted.json()) as { threadId: string };

    for (const userId of [charity.userId, corp.userId]) {
      authAs(userId);
      const res = await threadRoute(new Request('http://localhost/api'), params(threadId));
      expect(res.status).toBe(200);
      expect((await res.json()).messages).toHaveLength(1);
    }

    // A platform admin is not a party, and gets the same 404 as a stranger.
    authAs(admin, true);
    expect((await threadRoute(new Request('http://localhost/api'), params(threadId))).status).toBe(
      404,
    );
  });

  it('rate-limits a burst of messages with 429', async () => {
    const { corp, projectId } = await related();
    await expressInterest(corp.userId, projectId, corp.organisationId);
    authAs(corp.userId);

    // The limiter is 10/minute/user. An unmetered write that notifies someone
    // else is a spam vector, so the 11th must be refused.
    const codes: number[] = [];
    for (let i = 0; i < 12; i++) {
      const res = await postMessageRoute(
        body({ corporationOrgId: corp.organisationId, body: `spam ${i}` }),
        params(projectId),
      );
      codes.push(res.status);
    }
    // Exactly where the limiter bites, not merely "it bit somewhere":
    // `<= 10` would be satisfied by twelve consecutive 429s, which would mean
    // the limiter was refusing the very first message.
    expect(codes.slice(0, 10)).toEqual(Array(10).fill(201));
    expect(codes[10]).toBe(429);
    expect(codes[11]).toBe(429);

    // A refused message writes nothing — no row, no event, so no notification.
    const stored = await db.query.messages.findMany();
    expect(stored).toHaveLength(10);
    const events = await db.query.outbox.findMany({
      where: eq(outbox.eventType, 'MessagePosted'),
    });
    expect(events).toHaveLength(10);
  });
});
