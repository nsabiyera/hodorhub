import { eq, sql } from 'drizzle-orm';
import { db as defaultDb } from '@/db';
import { projectScores } from '@/db/schema';

/**
 * Scoring — owns the materialised `project_scores` read model (ARCHITECTURE.md §7)
 * and implements SUPPORT_SCORE_MODEL: log-compressed Support Score (cumulative),
 * a recency-weighted Momentum Score (7-day half-life), and the per-source cap that
 * stops one channel from dominating (anti-gaming §4). Payment- and brand-blind:
 * the only inputs are weighted engagement contributions.
 */
type Db = typeof defaultDb;
type Tx = Parameters<Parameters<Db['transaction']>[0]>[0];
type Executor = Db | Tx;

// Momentum decay: 7-day half-life (SUPPORT_SCORE_MODEL §3.2).
const DECAY_LAMBDA = Math.log(2) / 7;

/** SUPPORT_SCORE_MODEL §5: score = round(100 · log10(1 + R)). */
export function computeSupportScore(r: number): number {
  if (r <= 0) return 0;
  return Math.round(100 * Math.log10(1 + r));
}

/** Exponential recency weight for an event `ageDays` old. */
export function decayFactor(ageDays: number): number {
  return Math.exp(-DECAY_LAMBDA * Math.max(0, ageDays));
}

/**
 * Per-source cap (§4): no single source may contribute more than 50% of R.
 * A lone source is uncapped (it's all the support that exists); with ≥2 sources,
 * the top is capped to the sum of the others — bounding the payoff of buying one
 * channel without penalising a project strong across several.
 */
export function capSources(values: number[]): number {
  const total = values.reduce((a, b) => a + b, 0);
  if (values.filter((v) => v > 0).length <= 1) return total;
  const top = Math.max(...values);
  const others = total - top;
  return Math.min(top, others) + others;
}

export interface Contribution {
  source: string; // on_platform | facebook | twitter
  value: number; // weighted, trust-adjusted effective value
  ageDays: number;
}

/** Compute both scores from a project's engagement contributions. */
export function computeScores(contribs: Contribution[]): {
  supportScore: number;
  momentumScore: number;
  rawR: number;
} {
  const cumulative: Record<string, number> = {};
  const decayed: Record<string, number> = {};
  for (const c of contribs) {
    cumulative[c.source] = (cumulative[c.source] ?? 0) + c.value;
    decayed[c.source] = (decayed[c.source] ?? 0) + c.value * decayFactor(c.ageDays);
  }
  const rawR = capSources(Object.values(cumulative));
  const rDecayed = capSources(Object.values(decayed));
  return {
    supportScore: computeSupportScore(rawR),
    momentumScore: computeSupportScore(rDecayed),
    rawR,
  };
}

/** Materialise the computed scores. Called by Engagement inside its transaction. */
export async function applyScores(
  projectId: string,
  scores: { supportScore: number; momentumScore: number; rawR: number },
  exec: Executor = defaultDb,
): Promise<void> {
  await exec
    .insert(projectScores)
    .values({
      projectId,
      supportScore: scores.supportScore,
      momentumScore: scores.momentumScore,
      rawR: scores.rawR,
      lastUpdatedAt: sql`now()`,
    })
    .onConflictDoUpdate({
      target: projectScores.projectId,
      set: {
        supportScore: scores.supportScore,
        momentumScore: scores.momentumScore,
        rawR: scores.rawR,
        lastUpdatedAt: sql`now()`,
      },
    });
}

export function getScore(projectId: string, db: Db = defaultDb) {
  return db.query.projectScores.findFirst({ where: eq(projectScores.projectId, projectId) });
}
