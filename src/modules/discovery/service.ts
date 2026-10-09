import { and, desc, eq, ilike, inArray, sql } from 'drizzle-orm';
import { z } from 'zod';
import { db as defaultDb } from '@/db';
import { projects, projectScores, organisations } from '@/db/schema';
import { PROJECT_CATEGORIES } from '@/modules/projects';

/**
 * Discovery — the read model over published projects + their scores
 * (ARCHITECTURE.md §6). Ranking is driven ONLY by the support score, never by
 * plan/tier or branding (US-10.4 merit-integrity): no billing/branding table is
 * referenced here, by construction.
 */
type Db = typeof defaultDb;

const PUBLIC = ['published', 'in_delivery', 'completed'] as const;

export const discoverQuerySchema = z.object({
  q: z.string().trim().max(120).optional(),
  category: z.enum(PROJECT_CATEGORIES).optional(),
  sort: z.enum(['support', 'trending', 'recent']).default('support'),
  limit: z.coerce.number().int().min(1).max(50).default(20),
  offset: z.coerce.number().int().min(0).default(0),
});
export type DiscoverQuery = z.infer<typeof discoverQuerySchema>;

export async function listProjects(params: unknown, db: Db = defaultDb) {
  const p = discoverQuerySchema.parse(params);
  const conditions = [inArray(projects.status, [...PUBLIC])];
  if (p.q) conditions.push(ilike(projects.title, `%${p.q}%`));
  if (p.category) conditions.push(eq(projects.category, p.category)); // filter, never ranks (US-2.6)

  const orderBy =
    p.sort === 'recent'
      ? desc(projects.publishedAt)
      : p.sort === 'trending'
        ? desc(sql`coalesce(${projectScores.momentumScore}, 0)`)
        : desc(sql`coalesce(${projectScores.supportScore}, 0)`);

  return db
    .select({
      id: projects.id,
      title: projects.title,
      description: projects.description,
      status: projects.status,
      category: projects.category,
      publishedAt: projects.publishedAt,
      charityName: organisations.name,
      supportScore: sql<number>`coalesce(${projectScores.supportScore}, 0)`,
      momentumScore: sql<number>`coalesce(${projectScores.momentumScore}, 0)`,
    })
    .from(projects)
    .leftJoin(projectScores, eq(projectScores.projectId, projects.id))
    .leftJoin(organisations, eq(organisations.id, projects.charityOrgId))
    .where(and(...conditions))
    .orderBy(orderBy)
    .limit(p.limit)
    .offset(p.offset);
}
