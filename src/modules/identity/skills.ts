/**
 * US-1.5 — the volunteer skills registry.
 *
 * ONE controlled list, held in code, in the shape of US-11.12's template
 * allow-list. Every skill declares the existing US-2.6 `project_category`
 * values it serves, so US-4.3 can match employees to project needs on the
 * taxonomy the product already has instead of inventing a second axis.
 *
 * Identity owns it because Identity owns the column it governs (a membership's
 * skills) and sits at the root of the module graph — so when US-4.3 makes
 * Projects a consumer, no cycle appears.
 *
 * DELIBERATELY CODE, NOT AN ADMIN TOGGLE, for the same reason as the template
 * allow-list: adding a skill is a reviewed pull request, not a runtime switch.
 *
 * **Codes are append-only.** They are stored in `membership_profile_skills`
 * rows, so renaming one in place silently orphans every volunteer who picked
 * it (the US-8.2 notification-kind lesson, verbatim). Retire a skill by
 * removing it from this registry AND migrating its rows — never by renaming.
 */

/** The US-2.6 project categories a skill can serve. */
export type SkillCategory =
  | 'software'
  | 'design'
  | 'construction'
  | 'marketing'
  | 'fundraising'
  | 'events'
  | 'research'
  | 'legal'
  | 'operations';

/**
 * Chosen at **role/craft** granularity, never at tool granularity: a charity
 * asks for "a developer", not "someone who knows Next.js 15", and a tool list
 * would need pruning every year while a craft list does not. A skill earns its
 * place by being something a charity would actually write in a resource need.
 */
export const VOLUNTEER_SKILLS = [
  // Software
  { code: 'backend-development', label: 'Backend development', categories: ['software'] },
  {
    code: 'frontend-development',
    label: 'Frontend development',
    categories: ['software', 'design'],
  },
  { code: 'mobile-development', label: 'Mobile app development', categories: ['software'] },
  { code: 'qa-testing', label: 'Software testing & QA', categories: ['software'] },
  {
    code: 'devops-cloud',
    label: 'DevOps & cloud infrastructure',
    categories: ['software', 'operations'],
  },
  { code: 'data-engineering', label: 'Data engineering', categories: ['software', 'research'] },
  {
    code: 'security-engineering',
    label: 'Security engineering',
    categories: ['software', 'operations'],
  },

  // Design
  { code: 'ui-design', label: 'UI & interaction design', categories: ['design', 'software'] },
  { code: 'ux-research', label: 'UX & user research', categories: ['design', 'research'] },
  {
    code: 'graphic-design',
    label: 'Graphic design & branding',
    categories: ['design', 'marketing'],
  },
  {
    code: 'copywriting',
    label: 'Copywriting & editing',
    categories: ['design', 'marketing', 'fundraising'],
  },
  { code: 'accessibility', label: 'Accessibility (a11y)', categories: ['design', 'software'] },

  // Construction
  { code: 'carpentry', label: 'Carpentry & joinery', categories: ['construction'] },
  { code: 'electrical', label: 'Electrical work', categories: ['construction'] },
  { code: 'plumbing', label: 'Plumbing & heating', categories: ['construction'] },
  {
    code: 'general-building',
    label: 'General building & renovation',
    categories: ['construction'],
  },
  {
    code: 'architecture-surveying',
    label: 'Architecture & surveying',
    categories: ['construction', 'design'],
  },
  {
    code: 'health-and-safety',
    label: 'Health & safety',
    categories: ['construction', 'events', 'operations'],
  },

  // Marketing
  { code: 'digital-marketing', label: 'Digital marketing & SEO', categories: ['marketing'] },
  {
    code: 'social-media',
    label: 'Social media management',
    categories: ['marketing', 'fundraising'],
  },
  {
    code: 'video-photography',
    label: 'Video & photography',
    categories: ['marketing', 'design', 'events'],
  },
  { code: 'public-relations', label: 'PR & communications', categories: ['marketing', 'events'] },

  // Fundraising
  {
    code: 'grant-writing',
    label: 'Grant writing & bid support',
    categories: ['fundraising', 'research'],
  },
  {
    code: 'corporate-partnerships',
    label: 'Partnerships & major donors',
    categories: ['fundraising', 'marketing'],
  },
  {
    code: 'fundraising-campaigns',
    label: 'Fundraising campaign design',
    categories: ['fundraising', 'marketing'],
  },

  // Events
  {
    code: 'event-production',
    label: 'Event production & logistics',
    categories: ['events', 'operations'],
  },
  {
    code: 'volunteer-coordination',
    label: 'Volunteer coordination',
    categories: ['events', 'operations'],
  },
  {
    code: 'facilitation-training',
    label: 'Facilitation & training',
    categories: ['events', 'operations', 'research'],
  },

  // Research / data
  { code: 'data-analysis', label: 'Data analysis', categories: ['research', 'software'] },
  {
    code: 'impact-evaluation',
    label: 'Impact measurement & evaluation',
    categories: ['research', 'fundraising'],
  },
  {
    code: 'data-science',
    label: 'Data science & machine learning',
    categories: ['research', 'software'],
  },

  // Legal
  { code: 'contract-law', label: 'Contracts & commercial law', categories: ['legal'] },
  {
    code: 'charity-governance',
    label: 'Charity governance & compliance',
    categories: ['legal', 'operations'],
  },
  { code: 'employment-law', label: 'Employment & HR law', categories: ['legal', 'operations'] },
  {
    code: 'data-protection-law',
    label: 'Data protection & privacy law',
    categories: ['legal', 'operations', 'software'],
  },

  // Operations
  {
    code: 'project-management',
    label: 'Project & delivery management',
    categories: ['operations', 'software', 'construction', 'events'],
  },
  {
    code: 'finance-accounting',
    label: 'Finance & accounting',
    categories: ['operations', 'fundraising'],
  },
  { code: 'hr-people', label: 'HR & people operations', categories: ['operations'] },
  {
    code: 'it-support',
    label: 'IT support & systems administration',
    categories: ['operations', 'software'],
  },
] as const satisfies readonly {
  code: string;
  label: string;
  categories: readonly SkillCategory[];
}[];

export type VolunteerSkill = (typeof VOLUNTEER_SKILLS)[number];
export type VolunteerSkillCode = VolunteerSkill['code'];

/**
 * Codes as a non-empty tuple so `z.enum` derives from the registry rather than
 * restating it — schema and allow-list cannot drift (the US-11.12 pattern).
 */
export const VOLUNTEER_SKILL_CODES = VOLUNTEER_SKILLS.map((s) => s.code) as unknown as [
  VolunteerSkillCode,
  ...VolunteerSkillCode[],
];

const SKILL_BY_CODE = new Map<string, VolunteerSkill>(VOLUNTEER_SKILLS.map((s) => [s.code, s]));

/** The registry entry for a code, or undefined for a retired/unknown one. */
export function getSkill(code: string): VolunteerSkill | undefined {
  return SKILL_BY_CODE.get(code);
}

/** Every skill serving a project category — the US-4.3 forward lookup. */
export function skillsForCategory(category: SkillCategory): VolunteerSkill[] {
  return VOLUNTEER_SKILLS.filter((s) => (s.categories as readonly string[]).includes(category));
}

/**
 * The categories a set of skills covers. Unknown codes are ignored rather than
 * throwing: a stored row for a retired skill must not break a profile read.
 */
export function categoriesForSkills(codes: string[]): SkillCategory[] {
  const out = new Set<SkillCategory>();
  for (const code of codes) {
    for (const c of getSkill(code)?.categories ?? []) out.add(c);
  }
  return [...out];
}

/**
 * Seniority is **descriptive only** — it ranks nobody, gates no allocation and
 * unlocks no task (US-1.5). There is deliberately **no ordinal field**: the
 * moment a `rank: number` exists, something sorts by it. Nullable, because a
 * contractor, an executive or a non-technical volunteer may genuinely not sit
 * on a ladder, and a forced choice manufactures junk data US-4.3 would match on.
 */
export const SENIORITY_LEVELS = [
  { code: 'learning', label: 'Learning / early career' },
  { code: 'practitioner', label: 'Practitioner' },
  { code: 'experienced', label: 'Experienced' },
  { code: 'lead', label: 'Lead / principal' },
  { code: 'executive', label: 'Executive / director' },
  { code: 'specialist', label: 'Independent specialist' },
] as const;

export type SeniorityLevel = (typeof SENIORITY_LEVELS)[number];
export type SeniorityCode = SeniorityLevel['code'];

export const SENIORITY_CODES = SENIORITY_LEVELS.map((s) => s.code) as unknown as [
  SeniorityCode,
  ...SeniorityCode[],
];

export function getSeniority(code: string): SeniorityLevel | undefined {
  return SENIORITY_LEVELS.find((s) => s.code === code);
}
