import { describe, it, expect } from 'vitest';
import { eq } from 'drizzle-orm';
import { testDb } from '@/test/db';
import {
  agentDeliveryRuns,
  runBudgets,
  runBudgetLedger,
  computePledges,
  projects,
  organisations,
} from '@/db/schema';
import { reserveStep, settleStep, releaseReservation, getBalance } from './budget';
import { BudgetExceededError } from './errors';

// Minimal fixture: a run with a £1.00 (100p) budget. Foreign keys require a
// project + orgs + compute_pledge to exist; insert the bare rows directly.
async function seedRun(committedMinor: number): Promise<string> {
  const [charity] = await testDb
    .insert(organisations)
    .values({ name: 'C', type: 'charity', status: 'verified' })
    .returning();
  const [corp] = await testDb
    .insert(organisations)
    .values({ name: 'Co', type: 'corporation', status: 'verified' })
    .returning();
  const [project] = await testDb
    .insert(projects)
    .values({
      charityOrgId: charity!.id,
      title: 'T',
      description: 'S',
      category: 'software',
      status: 'in_delivery',
    })
    .returning();
  const [pledge] = await testDb
    .insert(computePledges)
    .values({
      projectId: project!.id,
      corporationOrgId: corp!.id,
      templateCode: 'static-site',
      budgetCommittedMinor: committedMinor,
      status: 'accepted',
    })
    .returning();
  const [run] = await testDb
    .insert(agentDeliveryRuns)
    .values({
      projectId: project!.id,
      charityOrgId: charity!.id,
      corporationOrgId: corp!.id,
      computePledgeId: pledge!.id,
      templateCode: 'static-site',
      priceBookVersion: '2026-07',
    })
    .returning();
  await testDb.insert(runBudgets).values({ runId: run!.id, committedMinor });
  return run!.id;
}

describe('agent-delivery budget (reserve-before-spend)', () => {
  it('reserves, settles at actual cost, and releases the difference', async () => {
    const runId = await seedRun(100);
    await reserveStep(testDb, runId, 40);
    await settleStep(testDb, runId, 40, 25, { model: 'fake', inputTokens: 100, outputTokens: 200 });
    const b = await getBalance(testDb, runId);
    expect(b.consumedMinor).toBe(25);
    expect(b.reservedMinor).toBe(0);
    expect(b.remainingMinor).toBe(75);
  });

  it('refuses a reservation that would breach the ceiling', async () => {
    const runId = await seedRun(100);
    await reserveStep(testDb, runId, 80);
    await expect(reserveStep(testDb, runId, 30)).rejects.toBeInstanceOf(BudgetExceededError);
    const b = await getBalance(testDb, runId);
    expect(b.reservedMinor).toBe(80); // unchanged by the refused reservation
  });

  it('releases a reservation back to remaining and records a release ledger entry', async () => {
    const runId = await seedRun(100);
    await reserveStep(testDb, runId, 40);
    await releaseReservation(testDb, runId, 40);
    const b = await getBalance(testDb, runId);
    expect(b.reservedMinor).toBe(0);
    expect(b.consumedMinor).toBe(0);
    expect(b.remainingMinor).toBe(100);
    const ledger = await testDb
      .select()
      .from(runBudgetLedger)
      .where(eq(runBudgetLedger.runId, runId));
    expect(ledger.some((e) => e.entryType === 'release' && e.amountMinor === 40)).toBe(true);
  });
});
