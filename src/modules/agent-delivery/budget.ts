import { and, eq, sql } from 'drizzle-orm';
import { db as defaultDb } from '@/db';
import { runBudgets, runBudgetLedger } from '@/db/schema';
import { BudgetExceededError } from './errors';

type Db = typeof defaultDb;
type Tx = Parameters<Parameters<Db['transaction']>[0]>[0];
type Executor = Db | Tx;

/**
 * Reserve a step's worst-case cost BEFORE the model call. The conditional
 * UPDATE only succeeds while remaining >= estimate, so a step that can't be
 * afforded is never started (US-11.4). The run_budgets CHECK is the DB backstop.
 * Callers MUST invoke this inside db.transaction(...) so the balance UPDATE and
 * the ledger INSERT commit atomically.
 */
export async function reserveStep(
  exec: Executor,
  runId: string,
  estimateMinor: number,
): Promise<void> {
  const updated = await exec
    .update(runBudgets)
    .set({
      reservedMinor: sql`${runBudgets.reservedMinor} + ${estimateMinor}`,
      updatedAt: new Date(),
    })
    .where(
      and(
        eq(runBudgets.runId, runId),
        sql`${runBudgets.committedMinor} - ${runBudgets.consumedMinor} - ${runBudgets.reservedMinor} >= ${estimateMinor}`,
      ),
    )
    .returning({ runId: runBudgets.runId });
  if (updated.length === 0) throw new BudgetExceededError();
  await exec
    .insert(runBudgetLedger)
    .values({ runId, entryType: 'reserve', amountMinor: estimateMinor });
}

/**
 * Settle a reserved step at its actual cost, releasing the over-reservation.
 * Callers MUST invoke this inside db.transaction(...) (balance UPDATE + ledger INSERT
 * must be atomic). Over-settle is intentionally allowed to rely on the run_budgets CHECK
 * backstop — you can't refuse to pay for cost already incurred.
 */
export async function settleStep(
  exec: Executor,
  runId: string,
  estimateMinor: number,
  actualMinor: number,
  meta: { model: string; inputTokens: number; outputTokens: number },
): Promise<void> {
  await exec
    .update(runBudgets)
    .set({
      reservedMinor: sql`${runBudgets.reservedMinor} - ${estimateMinor}`,
      consumedMinor: sql`${runBudgets.consumedMinor} + ${actualMinor}`,
      updatedAt: new Date(),
    })
    .where(eq(runBudgets.runId, runId));
  await exec.insert(runBudgetLedger).values({
    runId,
    entryType: 'settle',
    amountMinor: actualMinor,
    model: meta.model,
    inputTokens: meta.inputTokens,
    outputTokens: meta.outputTokens,
  });
}

/**
 * Release a previously-reserved amount back to remaining without consuming it —
 * used when a step fails/aborts after reserving but before settling, so a thrown
 * model call never strands budget (US-11.4). Callers MUST invoke inside
 * db.transaction(...) (balance UPDATE + ledger INSERT must be atomic).
 */
export async function releaseReservation(
  exec: Executor,
  runId: string,
  estimateMinor: number,
): Promise<void> {
  await exec
    .update(runBudgets)
    .set({
      reservedMinor: sql`${runBudgets.reservedMinor} - ${estimateMinor}`,
      updatedAt: new Date(),
    })
    .where(eq(runBudgets.runId, runId));
  await exec
    .insert(runBudgetLedger)
    .values({ runId, entryType: 'release', amountMinor: estimateMinor });
}

export async function getBalance(exec: Executor, runId: string) {
  const row = await exec.query.runBudgets.findFirst({ where: eq(runBudgets.runId, runId) });
  if (!row) throw new Error(`No budget for run ${runId}`);
  return {
    committedMinor: row.committedMinor,
    reservedMinor: row.reservedMinor,
    consumedMinor: row.consumedMinor,
    remainingMinor: row.committedMinor - row.consumedMinor - row.reservedMinor,
  };
}
