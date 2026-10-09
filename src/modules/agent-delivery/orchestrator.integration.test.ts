import { describe, it, expect } from 'vitest';
import { and, eq } from 'drizzle-orm';
import { testDb } from '@/test/db';
import { runMilestones, agentDeliveryRuns, agentSteps, outbox } from '@/db/schema';
import { FakeModelProvider } from '@/lib/fake-model-provider';
import { FakeSandboxRunner } from '@/lib/fake-sandbox-runner';
import { fundComputeBudget, acceptComputePledge } from '@/modules/commitments';
import {
  registerCharity,
  registerCorporation,
  approveVerification,
  createPlatformAdmin,
  InvalidStateError,
} from '@/modules/identity';
import { createDraftProject, setResourceNeeds, publishProject } from '@/modules/projects';
import {
  runRequirementsPhase,
  runCurrentPhase,
  approveMilestone,
  requestChanges,
} from './orchestrator';
import { getBalance } from './budget';
import { estimateMaxCostMinor } from './budget-math';

async function authorisedRun(budgetMinor: number) {
  const admin = await createPlatformAdmin('admin@hh.com', 'admin-password-1', testDb);
  const charity = await registerCharity(
    {
      email: 'petra@goodcause.org',
      password: 'a-strong-password',
      charityName: 'Good Cause',
      regNumber: 'CH-1',
    },
    testDb,
  );
  const corp = await registerCorporation(
    {
      email: 'carlos@acme.com',
      password: 'a-strong-password',
      companyName: 'Acme',
      emailDomain: 'acme.com',
    },
    testDb,
  );
  await approveVerification(charity.verificationRequestId, admin, testDb);
  await approveVerification(corp.verificationRequestId, admin, testDb);
  const project = await createDraftProject(
    charity.userId,
    {
      charityOrgId: charity.organisationId,
      title: 'Portal',
      description: 'A worthy cause that needs a hand.',
      goal: 'Reach the finish line.',
      category: 'software',
    },
    testDb,
  );
  await setResourceNeeds(
    charity.userId,
    project.projectId,
    [
      {
        skill: 'Backend',
        role: 'Dev',
        kind: 'ongoing',
        quantity: 1,
        hoursPerWeek: 2,
        durationWeeks: 8,
      },
    ],
    testDb,
  );
  await publishProject(charity.userId, project.projectId, testDb);
  const { computePledgeId } = await fundComputeBudget(
    corp.userId,
    project.projectId,
    { corporationOrgId: corp.organisationId, templateCode: 'static-site', budgetMinor },
    testDb,
  );
  const { runId } = await acceptComputePledge(charity.userId, computePledgeId, testDb);
  return { charity, runId };
}

describe('agent-delivery orchestrator — requirements phase + gate', () => {
  it('runs the phase within budget, opens a gate, and advances on approval', async () => {
    const { charity, runId } = await authorisedRun(5000);
    const provider = new FakeModelProvider([
      {
        text: 'GIVEN a visitor WHEN they open the site THEN they see the mission',
        usage: { inputTokens: 300, outputTokens: 400 },
      },
    ]);
    const res = await runRequirementsPhase(runId, provider, testDb);
    expect(res.status).toBe('awaiting_review');

    const balance = await getBalance(testDb, runId);
    expect(balance.consumedMinor).toBeGreaterThan(0);
    expect(balance.reservedMinor).toBe(0);

    await approveMilestone(charity.userId, res.milestoneId, testDb);
    const run = await testDb.query.agentDeliveryRuns.findFirst({
      where: eq(agentDeliveryRuns.id, runId),
    });
    expect(run!.currentPhase).toBe('design');
    const events = await testDb
      .select()
      .from(outbox)
      .where(eq(outbox.eventType, 'MilestoneApproved'));
    expect(events).toHaveLength(1);
  });

  it('halts the run instead of overspending when the budget is tiny', async () => {
    const { runId } = await authorisedRun(1); // 1p — cannot afford a planner step
    const provider = new FakeModelProvider([{ text: 'x' }]);
    const res = await runRequirementsPhase(runId, provider, testDb);
    expect(res.status).toBe('halted');
    const run = await testDb.query.agentDeliveryRuns.findFirst({
      where: eq(agentDeliveryRuns.id, runId),
    });
    expect(run!.status).toBe('halted');
    expect(provider.calls).toHaveLength(0); // never called the model — reserve failed first
  });

  it('request-changes loops the phase back to running', async () => {
    const { charity, runId } = await authorisedRun(5000);
    const provider = new FakeModelProvider([{ text: 'draft one' }]);
    const res = await runRequirementsPhase(runId, provider, testDb);
    await requestChanges(charity.userId, res.milestoneId, 'Add an accessibility criterion', testDb);
    const ms = await testDb.query.runMilestones.findFirst({
      where: eq(runMilestones.id, res.milestoneId),
    });
    expect(ms!.status).toBe('changes_requested');
    const run = await testDb.query.agentDeliveryRuns.findFirst({
      where: eq(agentDeliveryRuns.id, runId),
    });
    expect(run!.status).toBe('running');
  });

  it('runs the design phase after requirements is approved, reading the requirements artifact', async () => {
    const { charity, runId } = await authorisedRun(20000);
    const provider = new FakeModelProvider([
      { text: 'GIVEN a visitor WHEN they open the site THEN they see the mission' },
      { text: 'ARCHITECTURE: static site + CMS; TASKS: scaffold, content, deploy' },
    ]);
    const r1 = await runCurrentPhase(runId, provider, testDb);
    expect(r1.status).toBe('awaiting_review');
    await approveMilestone(charity.userId, r1.milestoneId, testDb);

    const r2 = await runCurrentPhase(runId, provider, testDb);
    expect(r2.status).toBe('awaiting_review');
    // design phase ran: the design prompt included the approved requirements artifact
    const designCall = provider.calls[1]!;
    expect(designCall.tier).toBe('planner');
    expect(designCall.prompt).toContain('they see the mission');
    const design = await testDb.query.runMilestones.findFirst({
      where: and(eq(runMilestones.runId, runId), eq(runMilestones.phase, 'design')),
    });
    expect(design!.status).toBe('awaiting_review');
  });

  it('refuses to re-run an already-approved phase', async () => {
    const { charity, runId } = await authorisedRun(20000);
    const provider = new FakeModelProvider([{ text: 'criteria' }]);
    const r1 = await runCurrentPhase(runId, provider, testDb);
    await approveMilestone(charity.userId, r1.milestoneId, testDb);
    // run advanced to design; force currentPhase back to requirements to simulate a bad re-invoke
    await testDb
      .update(agentDeliveryRuns)
      .set({ currentPhase: 'requirements', status: 'authorized' })
      .where(eq(agentDeliveryRuns.id, runId));
    await expect(runCurrentPhase(runId, provider, testDb)).rejects.toBeInstanceOf(
      InvalidStateError,
    );
  });

  it('releases the reservation and halts when the model call throws', async () => {
    const { runId } = await authorisedRun(20000);
    const provider = {
      calls: [] as unknown[],
      async complete() {
        throw new Error('provider exploded');
      },
    } as unknown as FakeModelProvider;
    const r = await runCurrentPhase(runId, provider, testDb);
    expect(r.status).toBe('halted');
    const bal = await getBalance(testDb, runId);
    expect(bal.reservedMinor).toBe(0); // reservation released, not stranded
    expect(bal.consumedMinor).toBe(0);
    const run = await testDb.query.agentDeliveryRuns.findFirst({
      where: eq(agentDeliveryRuns.id, runId),
    });
    expect(run!.status).toBe('halted');
  });

  it('skips a phase not implemented in this slice (delivery)', async () => {
    const { runId } = await authorisedRun(20000);
    await testDb
      .update(agentDeliveryRuns)
      .set({ currentPhase: 'delivery', status: 'authorized' })
      .where(eq(agentDeliveryRuns.id, runId));
    const provider = new FakeModelProvider([{ text: 'x' }]);
    const r = await runCurrentPhase(runId, provider, testDb);
    expect(r.status).toBe('skipped');
    expect(provider.calls).toHaveLength(0);
  });

  it('a kill switch during the model call wins over settle (not overwritten to awaiting_gate)', async () => {
    const { runId } = await authorisedRun(20000);
    // Fake provider that simulates an admin halting the run mid-call, then returns normally.
    const provider = {
      async complete() {
        await testDb
          .update(agentDeliveryRuns)
          .set({ status: 'halted' })
          .where(eq(agentDeliveryRuns.id, runId));
        return {
          text: 'criteria',
          modelId: 'fake-planner',
          usage: { inputTokens: 100, outputTokens: 200, cacheTokens: 0 },
          stopReason: 'end' as const,
        };
      },
    } as unknown as FakeModelProvider;
    const r = await runCurrentPhase(runId, provider, testDb);
    expect(r.status).toBe('halted');
    const run = await testDb.query.agentDeliveryRuns.findFirst({
      where: eq(agentDeliveryRuns.id, runId),
    });
    expect(run!.status).toBe('halted'); // kill switch preserved, NOT awaiting_gate
  });

  it('runs the build phase: worker model step + sandbox build → awaiting_review', async () => {
    const { charity, runId } = await authorisedRun(50000);
    const provider = new FakeModelProvider([
      { text: 'criteria' },
      { text: 'design' },
      { text: 'CODE: index.html + tests' },
    ]);
    const sandbox = new FakeSandboxRunner();
    // advance requirements → approve → design → approve → build
    const r1 = await runCurrentPhase(runId, provider, testDb);
    await approveMilestone(charity.userId, r1.milestoneId, testDb);
    const r2 = await runCurrentPhase(runId, provider, testDb);
    await approveMilestone(charity.userId, r2.milestoneId, testDb);
    const r3 = await runCurrentPhase(runId, provider, testDb, { sandbox });
    expect(r3.status).toBe('awaiting_review');
    expect(sandbox.calls).toHaveLength(1);
    const ms = await testDb.query.runMilestones.findFirst({
      where: and(eq(runMilestones.runId, runId), eq(runMilestones.phase, 'build')),
    });
    expect(ms!.status).toBe('awaiting_review');
    const step = await testDb
      .select()
      .from(agentSteps)
      .where(and(eq(agentSteps.runId, runId), eq(agentSteps.phase, 'build')));
    expect(step[0]!.role).toBe('worker');
  });

  it('build phase throws if no sandbox runner is provided', async () => {
    const { charity, runId } = await authorisedRun(50000);
    const provider = new FakeModelProvider([
      { text: 'criteria' },
      { text: 'design' },
      { text: 'code' },
    ]);
    const r1 = await runCurrentPhase(runId, provider, testDb);
    await approveMilestone(charity.userId, r1.milestoneId, testDb);
    const r2 = await runCurrentPhase(runId, provider, testDb);
    await approveMilestone(charity.userId, r2.milestoneId, testDb);
    await expect(runCurrentPhase(runId, provider, testDb)).rejects.toBeInstanceOf(
      InvalidStateError,
    );
  });

  it('a budget-exceeded halt records an error step (audit symmetry)', async () => {
    const { runId } = await authorisedRun(1); // 1p — cannot afford a planner step
    const provider = new FakeModelProvider([{ text: 'x' }]);
    const r = await runCurrentPhase(runId, provider, testDb);
    expect(r.status).toBe('halted');
    expect(provider.calls).toHaveLength(0);
    const steps = await testDb.select().from(agentSteps).where(eq(agentSteps.runId, runId));
    expect(steps.some((s) => s.status === 'error')).toBe(true);
  });

  it('pins the exact reserved pence for the design phase — the prior-phase upper-bound formula (Plan B1)', async () => {
    const { charity, runId } = await authorisedRun(20000);
    const reqProvider = new FakeModelProvider([{ text: 'criteria' }]);
    const r1 = await runCurrentPhase(runId, reqProvider, testDb);
    expect(r1.status).toBe('awaiting_review');
    await approveMilestone(charity.userId, r1.milestoneId, testDb);

    // Capture the reservation while it is live: the reserve tx (before the
    // model call) has already committed by the time provider.complete() runs,
    // and the settle tx (after the model call) hasn't happened yet.
    let reservedDuringDesignCall: number | undefined;
    const spyProvider = {
      calls: [] as unknown[],
      async complete() {
        const balance = await getBalance(testDb, runId);
        reservedDuringDesignCall = balance.reservedMinor;
        return {
          text: 'architecture',
          modelId: 'fake-planner',
          usage: { inputTokens: 100, outputTokens: 200, cacheTokens: 0 },
          stopReason: 'end' as const,
        };
      },
    } as unknown as FakeModelProvider;

    const r2 = await runCurrentPhase(runId, spyProvider, testDb);
    expect(r2.status).toBe('awaiting_review');

    // Design phase's PhaseSpec (orchestrator.ts PHASE_SPECS.design): tier
    // 'planner', promptTokens 1800, maxOutput 3000. Its prior phase is
    // 'requirements' (PRIOR_PHASE.design), whose PhaseSpec.maxOutput is 2000.
    // The Plan B1 formula reserves against (promptTokens + priorPhase.maxOutput),
    // not promptTokens alone, because the prior artifact embedded in the
    // design prompt can be as large as what requirements was allowed to emit.
    const designPromptTokens = 1800;
    const requirementsMaxOutput = 2000;
    const designMaxOutput = 3000;
    const expectedReservedMinor = estimateMaxCostMinor(
      'planner',
      designPromptTokens + requirementsMaxOutput, // reservedPromptTokens = 3800
      designMaxOutput,
    );
    // ceil((3800*400 + 3000*2000) / 1e6) = ceil(7,520,000 / 1e6) = ceil(7.52) = 8.
    // (Reverting to promptTokens alone — dropping + requirementsMaxOutput —
    // would instead reserve ceil((1800*400 + 3000*2000)/1e6) = 7, failing this.)
    expect(expectedReservedMinor).toBe(8);
    expect(reservedDuringDesignCall).toBe(expectedReservedMinor);
  });
});
