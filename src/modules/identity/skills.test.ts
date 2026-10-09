import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import {
  VOLUNTEER_SKILLS,
  SENIORITY_LEVELS,
  getSkill,
  skillsForCategory,
  categoriesForSkills,
} from './skills';
import { profileSchema } from './profile';

/** The nine US-2.6 categories, read from the schema so the two cannot drift. */
const CATEGORIES = (() => {
  const src = readFileSync('src/db/schema.ts', 'utf8');
  const block = src.match(
    /export const projectCategory = pgEnum\('project_category', \[([^\]]*)\]/,
  );
  return [...block![1]!.matchAll(/'([^']+)'/g)].map((m) => m[1]!);
})();

describe('volunteer skills registry (US-1.5)', () => {
  it('maps every skill onto real project categories', () => {
    // Parsed from the schema rather than restated here: a hardcoded list would
    // keep passing after someone adds a tenth category, which is the drift the
    // one-registry rule exists to prevent.
    expect(CATEGORIES.length).toBe(9);
    for (const skill of VOLUNTEER_SKILLS) {
      expect(skill.categories.length).toBeGreaterThan(0);
      for (const c of skill.categories) expect(CATEGORIES).toContain(c);
    }
  });

  it('covers every category with at least one skill', () => {
    // Otherwise a charity could publish a project in a category no volunteer
    // can ever declare a skill for, and US-4.3 would return nothing for it.
    for (const c of CATEGORIES) {
      expect(skillsForCategory(c as never).length).toBeGreaterThan(0);
    }
  });

  it('has unique, stable, url-safe codes', () => {
    const codes = VOLUNTEER_SKILLS.map((s) => s.code);
    expect(new Set(codes).size).toBe(codes.length);
    for (const c of codes) expect(c).toMatch(/^[a-z0-9-]+$/);
    // NOT `expect(VOLUNTEER_SKILL_CODES).toEqual(codes)` — that compares the
    // derived tuple to the expression it is derived from, so it cannot fail
    // under any edit. Assert against the SCHEMA instead, which is what actually
    // guards the write path.
    for (const code of codes) {
      expect(profileSchema.shape.skills.safeParse([code]).success).toBe(true);
    }
    const rejected = profileSchema.shape.skills.safeParse(['definitely-not-a-skill']);
    expect(rejected.success).toBe(false);
  });

  it('has enough skills to be a real vocabulary', () => {
    // A registry gutted to a handful would still satisfy every loop above.
    expect(VOLUNTEER_SKILLS.length).toBeGreaterThanOrEqual(25);
    for (const c of CATEGORIES) {
      expect(skillsForCategory(c as never).length).toBeGreaterThanOrEqual(3);
    }
  });

  it('has unique seniority codes and NO ordinal field', () => {
    const codes = SENIORITY_LEVELS.map((s) => s.code);
    expect(new Set(codes).size).toBe(codes.length);
    // Seniority ranks nobody (US-1.5). The moment a numeric rank exists,
    // something sorts by it — so assert the shape has no number in it at all.
    for (const level of SENIORITY_LEVELS) {
      expect(Object.keys(level).sort()).toEqual(['code', 'label']);
      for (const v of Object.values(level)) expect(typeof v).toBe('string');
    }
  });

  it('ignores unknown codes rather than throwing', () => {
    // A stored row for a retired skill must not break a profile read.
    expect(getSkill('no-such-skill')).toBeUndefined();
    expect(categoriesForSkills(['no-such-skill'])).toEqual([]);
    expect(categoriesForSkills(['carpentry', 'no-such-skill'])).toEqual(['construction']);
  });

  it('is not a tool list', () => {
    // The registry is deliberately at role/craft granularity: a tool list needs
    // pruning every year and a charity does not ask for "React".
    const TOOLS = /react|angular|vue|python|excel|figma|salesforce|aws|azure|wordpress/i;
    for (const s of VOLUNTEER_SKILLS) {
      expect(s.code).not.toMatch(TOOLS);
      expect(s.label).not.toMatch(TOOLS);
    }
  });
});
