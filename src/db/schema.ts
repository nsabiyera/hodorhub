import {
  pgTable,
  pgEnum,
  uuid,
  text,
  integer,
  timestamp,
  jsonb,
  boolean,
  unique,
  uniqueIndex,
  index,
  bigserial,
  check,
  date,
} from 'drizzle-orm/pg-core';
import { sql } from 'drizzle-orm';

/**
 * HodorHub data model — realizes ARCHITECTURE.md §7. Tables are grouped by
 * bounded context. Cross-context references are by id only; a module never
 * reaches into another module's tables directly (enforced in application code).
 */

// ── Enums ────────────────────────────────────────────────────────────────────
export const orgType = pgEnum('org_type', ['charity', 'corporation']);
export const orgStatus = pgEnum('org_status', ['pending', 'verified', 'rejected']);
export const memberRole = pgEnum('member_role', [
  'charity_owner',
  'csr_manager',
  'manager',
  'volunteer',
]);
export const projectStatus = pgEnum('project_status', [
  'draft',
  'published',
  'in_delivery',
  'completed',
  'archived',
]);
export const resourceKind = pgEnum('resource_kind', ['ongoing', 'sprint']);
export const projectCategory = pgEnum('project_category', [
  'software',
  'design',
  'construction',
  'marketing',
  'fundraising',
  'events',
  'research',
  'legal',
  'operations',
]);
export const socialPlatform = pgEnum('social_platform', ['facebook', 'twitter']);
export const engagementStatus = pgEnum('engagement_status', [
  'provisional',
  'confirmed',
  'flagged',
]);
export const pledgeStatus = pgEnum('pledge_status', ['proposed', 'accepted', 'declined']);
export const hourStatus = pgEnum('hour_status', ['pending', 'approved', 'rejected']);
// US-6.3 — a delivery milestone is *open* until the CHARITY confirms it, the
// same shape as pending/approved hours and provided/received gifts: the party
// doing the work never declares the work done. "All tasks done" is derived, not
// stored, so nothing promotes itself to achieved.
export const deliveryMilestoneStatus = pgEnum('delivery_milestone_status', ['open', 'achieved']);
export const deliveryTaskStatus = pgEnum('delivery_task_status', ['todo', 'in_progress', 'done']);
export const brandingStatus = pgEnum('branding_status', ['default', 'active', 'pending_domain']);
export const authTokenKind = pgEnum('auth_token_kind', ['email_verify', 'password_reset']);
export const reportStatus = pgEnum('report_status', ['open', 'actioned', 'dismissed']);
export const digitalResourceKind = pgEnum('digital_resource_kind', [
  'cloud_credits',
  'api_budget',
  'llm_budget',
  'saas_seats',
  'hosting',
  'domains',
  'other',
]);
export const resourceGiftStatus = pgEnum('resource_gift_status', [
  'offered',
  'accepted',
  'declined',
  'provided',
  'received',
  'withdrawn',
]);
export const computePledgeStatus = pgEnum('compute_pledge_status', [
  'proposed',
  'accepted',
  'declined',
]);
export const agentRunStatus = pgEnum('agent_run_status', [
  'authorized',
  'running',
  'awaiting_gate',
  'paused',
  'halted',
  'completed',
  'failed',
]);
export const agentRunPhase = pgEnum('agent_run_phase', [
  'requirements',
  'design',
  'build',
  'delivery',
]);
export const milestoneStatus = pgEnum('milestone_status', [
  'pending',
  'awaiting_review',
  'approved',
  'changes_requested',
  'rejected',
]);
export const ledgerEntryType = pgEnum('ledger_entry_type', ['reserve', 'settle', 'release']);
export const deployedEnvironment = pgEnum('deployed_environment', ['staging', 'production']);
export const deployedEnvStatus = pgEnum('deployed_env_status', [
  'deploying',
  'live',
  'failed',
  'torn_down',
]);

// ── Identity & Org ─────────────────────────────────────────────────────────
export const organisations = pgTable('organisations', {
  id: uuid('id').primaryKey().defaultRandom(),
  type: orgType('type').notNull(),
  name: text('name').notNull(),
  regNumber: text('reg_number'),
  status: orgStatus('status').notNull().default('pending'),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
});

export const users = pgTable('users', {
  id: uuid('id').primaryKey().defaultRandom(),
  email: text('email').notNull().unique(),
  passwordHash: text('password_hash').notNull(),
  emailVerifiedAt: timestamp('email_verified_at', { withTimezone: true }),
  // Platform operator (Admin persona) — not an org member. Gates the
  // verification queue (US-1.3). Set out-of-band, never via public signup.
  isPlatformAdmin: boolean('is_platform_admin').notNull().default(false),
  // GDPR: consent captured at signup; deletedAt set on right-to-erasure.
  consentedAt: timestamp('consented_at', { withTimezone: true }),
  deletedAt: timestamp('deleted_at', { withTimezone: true }),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
});

export const memberships = pgTable(
  'memberships',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    userId: uuid('user_id')
      .notNull()
      .references(() => users.id),
    organisationId: uuid('organisation_id')
      .notNull()
      .references(() => organisations.id),
    role: memberRole('role').notNull(),
  },
  (t) => ({ uniqueMember: unique().on(t.userId, t.organisationId) }),
);

export const verificationRequests = pgTable('verification_requests', {
  id: uuid('id').primaryKey().defaultRandom(),
  organisationId: uuid('organisation_id')
    .notNull()
    .references(() => organisations.id),
  status: orgStatus('status').notNull().default('pending'),
  reviewerId: uuid('reviewer_id').references(() => users.id),
  reason: text('reason'),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
});

// Email-verification & password-reset tokens (only the SHA-256 hash is stored).
export const authTokens = pgTable('auth_tokens', {
  id: uuid('id').primaryKey().defaultRandom(),
  userId: uuid('user_id')
    .notNull()
    .references(() => users.id),
  kind: authTokenKind('kind').notNull(),
  tokenHash: text('token_hash').notNull(),
  expiresAt: timestamp('expires_at', { withTimezone: true }).notNull(),
  usedAt: timestamp('used_at', { withTimezone: true }),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
});

// Per-org branding config (ARCHITECTURE.md §3). Neutral marketplace is never branded.
export const orgBranding = pgTable('org_branding', {
  organisationId: uuid('organisation_id')
    .primaryKey()
    .references(() => organisations.id),
  logoAssetRef: text('logo_asset_ref'),
  faviconRef: text('favicon_ref'),
  themeTokens: jsonb('theme_tokens'),
  subdomain: text('subdomain').unique(),
  customDomain: text('custom_domain').unique(),
  domainVerifiedAt: timestamp('domain_verified_at', { withTimezone: true }),
  brandingStatus: brandingStatus('branding_status').notNull().default('default'),
});

// ── Billing & Entitlements ───────────────────────────────────────────────────
export const plans = pgTable('plans', {
  id: uuid('id').primaryKey().defaultRandom(),
  code: text('code').notNull().unique(),
  name: text('name').notNull(),
});

export const subscriptions = pgTable('subscriptions', {
  id: uuid('id').primaryKey().defaultRandom(),
  organisationId: uuid('organisation_id')
    .notNull()
    .references(() => organisations.id),
  planId: uuid('plan_id')
    .notNull()
    .references(() => plans.id),
  status: text('status').notNull().default('active'),
  // US-10.6 — the provider's own identifiers. Invoices are NOT mirrored here:
  // the provider is their system of record and a local copy would drift the
  // moment a refund or adjustment happened there.
  customerRef: text('customer_ref'),
  subscriptionRef: text('subscription_ref'),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
});

export const entitlements = pgTable('entitlements', {
  id: uuid('id').primaryKey().defaultRandom(),
  organisationId: uuid('organisation_id')
    .notNull()
    .references(() => organisations.id),
  feature: text('feature').notNull(),
  limitValue: integer('limit_value'),
});

// ── Projects ─────────────────────────────────────────────────────────────────
export const projects = pgTable('projects', {
  id: uuid('id').primaryKey().defaultRandom(),
  charityOrgId: uuid('charity_org_id')
    .notNull()
    .references(() => organisations.id),
  title: text('title').notNull(),
  // Nullable so a draft can be saved with only a title (US-2.1); required at publish.
  description: text('description'),
  goal: text('goal'),
  category: projectCategory('category'), // required at publish (US-2.6)
  status: projectStatus('status').notNull().default('draft'),
  publishedAt: timestamp('published_at', { withTimezone: true }),
  // US-7.3 — the result, written once when the charity completes the project.
  // Nullable: every project predates it, and only completion sets them.
  outcomeStory: text('outcome_story'),
  completedAt: timestamp('completed_at', { withTimezone: true }),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
});

export const projectResourceNeeds = pgTable('project_resource_needs', {
  id: uuid('id').primaryKey().defaultRandom(),
  projectId: uuid('project_id')
    .notNull()
    .references(() => projects.id),
  skill: text('skill'),
  role: text('role'),
  quantity: integer('quantity').notNull().default(1), // headcount, e.g. "1 backend developer"
  hoursPerWeek: integer('hours_per_week'),
  durationWeeks: integer('duration_weeks'),
  kind: resourceKind('kind').notNull().default('ongoing'),
});

// Sibling to project_resource_needs: the non-human resources a software
// project consumes (US-2.7). Coordination-only — quantity/unit are informational,
// never a monetary value.
export const digitalResourceNeeds = pgTable('digital_resource_needs', {
  id: uuid('id').primaryKey().defaultRandom(),
  projectId: uuid('project_id')
    .notNull()
    .references(() => projects.id),
  kind: digitalResourceKind('kind').notNull(),
  description: text('description'),
  quantity: integer('quantity'),
  unit: text('unit'),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
});

// ── Engagement ───────────────────────────────────────────────────────────────
export const socialConnections = pgTable('social_connections', {
  id: uuid('id').primaryKey().defaultRandom(),
  organisationId: uuid('organisation_id')
    .notNull()
    .references(() => organisations.id),
  platform: socialPlatform('platform').notNull(),
  tokenCiphertext: text('token_ciphertext').notNull(), // AES-256-GCM, see lib/crypto
  linkedPostRef: text('linked_post_ref'),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
});

export const engagementEvents = pgTable(
  'engagement_events',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    projectId: uuid('project_id')
      .notNull()
      .references(() => projects.id),
    source: text('source').notNull(), // on_platform | facebook | twitter
    action: text('action').notNull(), // like | share | comment | repost | quote ...
    actorRef: text('actor_ref'),
    externalEventId: text('external_event_id'), // for idempotent ingestion
    baseWeight: integer('base_weight').notNull(),
    trust: integer('trust').notNull(), // stored as 0..1000 (fixed-point of 0..1)
    effectiveValue: integer('effective_value').notNull(),
    status: engagementStatus('status').notNull().default('provisional'),
    occurredAt: timestamp('occurred_at', { withTimezone: true }).notNull(),
    ingestedAt: timestamp('ingested_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => ({ uniqueExternal: unique().on(t.source, t.externalEventId) }),
);

export const onPlatformSupports = pgTable(
  'on_platform_supports',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    projectId: uuid('project_id')
      .notNull()
      .references(() => projects.id),
    userId: uuid('user_id')
      .notNull()
      .references(() => users.id),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => ({ uniqueSupport: unique().on(t.projectId, t.userId) }),
);

// ── Scoring (materialised read model — written ONLY by the scoring worker) ────
export const projectScores = pgTable('project_scores', {
  projectId: uuid('project_id')
    .primaryKey()
    .references(() => projects.id),
  supportScore: integer('support_score').notNull().default(0),
  momentumScore: integer('momentum_score').notNull().default(0),
  rawR: integer('raw_r').notNull().default(0),
  lastUpdatedAt: timestamp('last_updated_at', { withTimezone: true }).notNull().defaultNow(),
});

// ── Commitments ──────────────────────────────────────────────────────────────
export const interests = pgTable('interests', {
  id: uuid('id').primaryKey().defaultRandom(),
  projectId: uuid('project_id')
    .notNull()
    .references(() => projects.id),
  corporationOrgId: uuid('corporation_org_id')
    .notNull()
    .references(() => organisations.id),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
});

export const pledges = pgTable(
  'pledges',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    projectId: uuid('project_id')
      .notNull()
      .references(() => projects.id),
    corporationOrgId: uuid('corporation_org_id')
      .notNull()
      .references(() => organisations.id),
    resourceType: text('resource_type').notNull(),
    quantity: integer('quantity').notNull(),
    cadence: text('cadence'),
    durationWeeks: integer('duration_weeks'),
    status: pledgeStatus('status').notNull().default('proposed'),
    decidedBy: uuid('decided_by').references(() => users.id),
    reason: text('reason'),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  // DB backstop (TECH_DEBT M2): at most one ACCEPTED pledge per project — closes
  // the reopen→double-accept hole even if the application logic misses it.
  (t) => ({
    oneAcceptedPerProject: uniqueIndex('pledges_one_accepted_per_project')
      .on(t.projectId)
      .where(sql`${t.status} = 'accepted'`),
  }),
);

// Commitments sibling aggregate to `pledges` (US-5.5/US-6.5). A corporation's
// in-kind gift toward a project's digital-resource need. Coordination-only:
// HodorHub records the gift, provisions/values nothing. Deliberately NOT a
// `kind` on pledges — many gifts per project are allowed, and acceptance must
// never enter the delivery machinery.
export const resourceGifts = pgTable('resource_gifts', {
  id: uuid('id').primaryKey().defaultRandom(),
  projectId: uuid('project_id')
    .notNull()
    .references(() => projects.id),
  corporationOrgId: uuid('corporation_org_id')
    .notNull()
    .references(() => organisations.id),
  needId: uuid('need_id').references(() => digitalResourceNeeds.id, { onDelete: 'set null' }), // nullable: PULL default, PUSH-ready
  kind: digitalResourceKind('kind').notNull(),
  quantity: integer('quantity'),
  unit: text('unit'),
  note: text('note'),
  status: resourceGiftStatus('status').notNull().default('offered'),
  decidedBy: uuid('decided_by').references(() => users.id),
  providedAt: timestamp('provided_at', { withTimezone: true }),
  receivedAt: timestamp('received_at', { withTimezone: true }),
  reason: text('reason'),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
});

// ── Agent Delivery (Epic 11) ──────────────────────────────────────────────────
// Commitments sibling aggregate to `pledges`/`resource_gifts`: a corporation's
// FUNDED compute budget for agent delivery. Merit-blind (US-11.9) — never an
// input to scoring/discovery. Distinct from resource_gifts: HodorHub actively
// draws this budget down and escrows it.
export const computePledges = pgTable(
  'compute_pledges',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    projectId: uuid('project_id')
      .notNull()
      .references(() => projects.id),
    corporationOrgId: uuid('corporation_org_id')
      .notNull()
      .references(() => organisations.id),
    templateCode: text('template_code').notNull(),
    budgetCurrency: text('budget_currency').notNull().default('GBP'),
    budgetCommittedMinor: integer('budget_committed_minor').notNull(),
    status: computePledgeStatus('status').notNull().default('proposed'),
    decidedBy: uuid('decided_by').references(() => users.id),
    reason: text('reason'),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => ({
    oneAcceptedPerProject: uniqueIndex('compute_pledges_one_accepted_per_project')
      .on(t.projectId)
      .where(sql`${t.status} = 'accepted'`),
    positiveBudget: check('compute_pledges_budget_positive', sql`${t.budgetCommittedMinor} > 0`),
  }),
);

// AgentDelivery bounded context — owns the run lifecycle. Bi-tenant: charity
// owns/approves, corporation funds.
export const agentDeliveryRuns = pgTable('agent_delivery_runs', {
  id: uuid('id').primaryKey().defaultRandom(),
  projectId: uuid('project_id')
    .notNull()
    .references(() => projects.id),
  charityOrgId: uuid('charity_org_id')
    .notNull()
    .references(() => organisations.id),
  corporationOrgId: uuid('corporation_org_id')
    .notNull()
    .references(() => organisations.id),
  computePledgeId: uuid('compute_pledge_id')
    .notNull()
    .references(() => computePledges.id),
  templateCode: text('template_code').notNull(),
  provider: text('provider').notNull().default('fake'),
  priceBookVersion: text('price_book_version').notNull(),
  status: agentRunStatus('status').notNull().default('authorized'),
  currentPhase: agentRunPhase('current_phase').notNull().default('requirements'),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
});

// 1:1 materialised balance. The CHECK is the hard ceiling: runaway spend is
// impossible by construction (US-11.4).
export const runBudgets = pgTable(
  'run_budgets',
  {
    runId: uuid('run_id')
      .primaryKey()
      .references(() => agentDeliveryRuns.id),
    currency: text('currency').notNull().default('GBP'),
    committedMinor: integer('committed_minor').notNull(),
    reservedMinor: integer('reserved_minor').notNull().default(0),
    consumedMinor: integer('consumed_minor').notNull().default(0),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => ({
    withinCeiling: check(
      'run_budgets_within_ceiling',
      sql`${t.consumedMinor} + ${t.reservedMinor} <= ${t.committedMinor}`,
    ),
    nonNegative: check(
      'run_budgets_non_negative',
      sql`${t.reservedMinor} >= 0 AND ${t.consumedMinor} >= 0`,
    ),
  }),
);

// Append-only reserve-before-spend audit.
export const runBudgetLedger = pgTable('run_budget_ledger', {
  id: uuid('id').primaryKey().defaultRandom(),
  runId: uuid('run_id')
    .notNull()
    .references(() => agentDeliveryRuns.id),
  stepId: uuid('step_id'),
  entryType: ledgerEntryType('entry_type').notNull(),
  amountMinor: integer('amount_minor').notNull(),
  model: text('model'),
  inputTokens: integer('input_tokens'),
  outputTokens: integer('output_tokens'),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
});

// The human-in-the-loop gate. State machine mirrors hour_logs (US-6.2a).
export const runMilestones = pgTable(
  'run_milestones',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    runId: uuid('run_id')
      .notNull()
      .references(() => agentDeliveryRuns.id),
    phase: agentRunPhase('phase').notNull(),
    status: milestoneStatus('status').notNull().default('pending'),
    artifactRef: text('artifact_ref'),
    reviewerUserId: uuid('reviewer_user_id').references(() => users.id),
    reason: text('reason'),
    openedAt: timestamp('opened_at', { withTimezone: true }),
    decidedAt: timestamp('decided_at', { withTimezone: true }),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => ({ onePerPhase: unique('run_milestones_one_per_phase').on(t.runId, t.phase) }),
);

// Attribution + audit — NOT hours. Measured in tokens/cost, never converted.
export const agentSteps = pgTable('agent_steps', {
  id: uuid('id').primaryKey().defaultRandom(),
  runId: uuid('run_id')
    .notNull()
    .references(() => agentDeliveryRuns.id),
  phase: agentRunPhase('phase').notNull(),
  role: text('role').notNull(),
  stepIndex: integer('step_index').notNull(),
  inputTokens: integer('input_tokens').notNull().default(0),
  outputTokens: integer('output_tokens').notNull().default(0),
  costMinor: integer('cost_minor').notNull().default(0),
  status: text('status').notNull(),
  error: text('error'),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
});

// Delivered-app environments (Epic 11 / Slice 3). Sole writer is the Deployer.
// Read by the charity UI. Never referenced by Scoring/Discovery (US-11.9).
export const deployedEnvironments = pgTable('deployed_environments', {
  id: uuid('id').primaryKey().defaultRandom(),
  runId: uuid('run_id')
    .notNull()
    .references(() => agentDeliveryRuns.id),
  environment: deployedEnvironment('environment').notNull(),
  url: text('url'),
  revisionRef: text('revision_ref'),
  status: deployedEnvStatus('status').notNull().default('deploying'),
  // Who approved this environment into existence (US-11.8/11.10). Set on
  // 'production' rows, which exist only because a charity owner explicitly
  // promoted; null on 'staging' rows, which nobody approves — the agents'
  // delivery phase deploys those.
  promotedBy: uuid('promoted_by').references(() => users.id),
  deployedAt: timestamp('deployed_at', { withTimezone: true }),
  tornDownAt: timestamp('torn_down_at', { withTimezone: true }),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
});

// ── Delivery ─────────────────────────────────────────────────────────────────
export const deliveryWorkspaces = pgTable('delivery_workspaces', {
  id: uuid('id').primaryKey().defaultRandom(),
  projectId: uuid('project_id')
    .notNull()
    .references(() => projects.id),
  pledgeId: uuid('pledge_id')
    .notNull()
    .references(() => pledges.id),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
});

export const allocations = pgTable('allocations', {
  id: uuid('id').primaryKey().defaultRandom(),
  deliveryWorkspaceId: uuid('delivery_workspace_id')
    .notNull()
    .references(() => deliveryWorkspaces.id),
  volunteerUserId: uuid('volunteer_user_id')
    .notNull()
    .references(() => users.id),
  hoursPerWeek: integer('hours_per_week').notNull(),
});

export const hourLogs = pgTable('hour_logs', {
  id: uuid('id').primaryKey().defaultRandom(),
  allocationId: uuid('allocation_id')
    .notNull()
    .references(() => allocations.id),
  volunteerUserId: uuid('volunteer_user_id')
    .notNull()
    .references(() => users.id),
  hours: integer('hours').notNull(),
  note: text('note'),
  // Hours count toward reporting ONLY when approved (US-6.2a). Default pending.
  status: hourStatus('status').notNull().default('pending'),
  approvedBy: uuid('approved_by').references(() => users.id),
  decidedReason: text('decided_reason'),
  loggedAt: timestamp('logged_at', { withTimezone: true }).notNull().defaultNow(),
});

/**
 * US-6.3 — milestones on a delivery workspace. Created and confirmed by the
 * charity owner only; `achievedAt`/`achievedBy` are written in the same update
 * as the status, so an achieved milestone always carries who confirmed it.
 * Distinct from `run_milestones`, which are the Epic 11 agent phase gates.
 */
export const deliveryMilestones = pgTable('delivery_milestones', {
  id: uuid('id').primaryKey().defaultRandom(),
  deliveryWorkspaceId: uuid('delivery_workspace_id')
    .notNull()
    .references(() => deliveryWorkspaces.id),
  title: text('title').notNull(),
  dueOn: date('due_on'), // optional: not every milestone has a date to be late against
  status: deliveryMilestoneStatus('status').notNull().default('open'),
  achievedAt: timestamp('achieved_at', { withTimezone: true }),
  achievedBy: uuid('achieved_by').references(() => users.id),
  createdBy: uuid('created_by')
    .notNull()
    .references(() => users.id),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
});

/**
 * US-6.3 — tasks on a delivery workspace. `assignedAllocationId` points at an
 * `allocations` row rather than a user id: that makes "the assignee is a
 * volunteer allocated to THIS workspace" true by construction instead of by a
 * check someone can forget. `milestoneId` is nullable because delivery really
 * does start with loose tasks before the milestones are drawn.
 */
export const deliveryTasks = pgTable('delivery_tasks', {
  id: uuid('id').primaryKey().defaultRandom(),
  deliveryWorkspaceId: uuid('delivery_workspace_id')
    .notNull()
    .references(() => deliveryWorkspaces.id),
  milestoneId: uuid('milestone_id').references(() => deliveryMilestones.id),
  title: text('title').notNull(),
  detail: text('detail'),
  status: deliveryTaskStatus('status').notNull().default('todo'),
  assignedAllocationId: uuid('assigned_allocation_id').references(() => allocations.id),
  completedAt: timestamp('completed_at', { withTimezone: true }),
  createdBy: uuid('created_by')
    .notNull()
    .references(() => users.id),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
});

// ── Notifications & Audit ────────────────────────────────────────────────────

/**
 * US-8.2 — one row per user per notification *kind* they have actually changed.
 * An absent row means the platform default from the code registry
 * (`notifications/preferences.ts`), so nobody needs a row to exist and no
 * backfill is required — the same "absent means default" rule as an absent
 * subscription meaning Starter (US-10.2).
 *
 * `kind` is text, not an enum: the registry is the single authority for which
 * kinds exist (US-11.12's lesson), and adding one should not need a migration.
 * Reads iterate the registry, so a row for a retired kind is simply ignored.
 */
export const notificationPreferences = pgTable(
  'notification_preferences',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    userId: uuid('user_id')
      .notNull()
      .references(() => users.id),
    kind: text('kind').notNull(),
    inApp: boolean('in_app').notNull(),
    email: boolean('email').notNull(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => ({ onePerKind: unique('notification_preferences_one_per_kind').on(t.userId, t.kind) }),
);

export const notifications = pgTable('notifications', {
  id: uuid('id').primaryKey().defaultRandom(),
  userId: uuid('user_id')
    .notNull()
    .references(() => users.id),
  type: text('type').notNull(),
  payload: jsonb('payload'),
  readAt: timestamp('read_at', { withTimezone: true }),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
});

// User-reported content for moderation (US-9.2).
export const contentReports = pgTable('content_reports', {
  id: uuid('id').primaryKey().defaultRandom(),
  reporterUserId: uuid('reporter_user_id')
    .notNull()
    .references(() => users.id),
  projectId: uuid('project_id')
    .notNull()
    .references(() => projects.id),
  reason: text('reason').notNull(),
  status: reportStatus('status').notNull().default('open'),
  reviewedBy: uuid('reviewed_by').references(() => users.id),
  decidedReason: text('decided_reason'),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
});

export const auditLog = pgTable('audit_log', {
  id: uuid('id').primaryKey().defaultRandom(),
  actorId: uuid('actor_id').references(() => users.id),
  action: text('action').notNull(),
  entity: text('entity').notNull(),
  entityId: uuid('entity_id'),
  metadata: jsonb('metadata'),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
});

// ── Platform controls (US-11.5) ──────────────────────────────────────────────
/**
 * The one and only platform_controls row. The CHECK below pins the primary key
 * to this uuid, so at most one row can ever exist.
 */
export const PLATFORM_CONTROLS_ID = '00000000-0000-0000-0000-000000000001';

/**
 * Platform-wide operational switches (US-11.5). Deliberately NOT seeded by the
 * migration: resetDb() truncates every app table between integration tests, so
 * an absent row is a normal state and means "the brake has never been pulled"
 * — readers default to false and writers upsert.
 */
export const platformControls = pgTable(
  'platform_controls',
  {
    id: uuid('id').primaryKey(),
    agentDeliveryPaused: boolean('agent_delivery_paused').notNull().default(false),
    updatedBy: uuid('updated_by').references(() => users.id),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => ({
    // The uuid is written as a literal, not interpolated from
    // PLATFORM_CONTROLS_ID: drizzle would bind a JS string as a query
    // parameter, which is invalid inside DDL. Keep the two in sync.
    singleton: check(
      'platform_controls_singleton',
      sql`${t.id} = '00000000-0000-0000-0000-000000000001'::uuid`,
    ),
  }),
);

// ── Messaging ────────────────────────────────────────────────────────────────

/**
 * US-8.3 — one conversation per (project, corporation). The unique constraint
 * IS the acceptance criterion: "there is one conversation for that project and
 * that corporation" survives a careless future query only as a database rule,
 * not as a promise repeated in every WHERE clause.
 *
 * The key holds no pledge id, workspace id or lifecycle state, so the thread is
 * the same before, during and after delivery, survives a reopen and re-pledge,
 * and a second corporation on the same project (US-5.4) necessarily gets its
 * own row. `charity_org_id` is deliberately NOT stored: it is derivable from the
 * project, can never change, and copying it would fork a fact Projects owns.
 */
export const messageThreads = pgTable(
  'message_threads',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    projectId: uuid('project_id')
      .notNull()
      .references(() => projects.id),
    corporationOrgId: uuid('corporation_org_id')
      .notNull()
      .references(() => organisations.id),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    lastMessageAt: timestamp('last_message_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => ({
    onePerCorporation: unique('message_threads_one_per_corporation').on(
      t.projectId,
      t.corporationOrgId,
    ),
    byProject: index('message_threads_project_idx').on(t.projectId),
  }),
);

/**
 * `seq` rather than `created_at` is the ordering key: `now()` is transaction
 * start time, so messages written in one transaction carry byte-identical
 * timestamps and uuid v4 is not a tiebreaker — "oldest-first" would be
 * "random-first" among ties. It is global rather than per-thread, so a thread's
 * values have gaps; only the order matters, and it is also the paging cursor.
 *
 * `author_org_id` is denormalised on purpose: attribution is a fact of the
 * message when it was written. Re-deriving it from `memberships` would rewrite
 * history when someone leaves the company (US-10.7 can delete that row).
 *
 * `redacted_at` is the GDPR tombstone — erasure blanks the body and stamps this
 * rather than deleting the row, so the other organisation keeps its record of a
 * two-party negotiation. The UI branches on the column, never on an empty body.
 */
export const messages = pgTable(
  'messages',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    threadId: uuid('thread_id')
      .notNull()
      .references(() => messageThreads.id),
    seq: bigserial('seq', { mode: 'number' }).notNull(),
    authorUserId: uuid('author_user_id')
      .notNull()
      .references(() => users.id),
    authorOrgId: uuid('author_org_id')
      .notNull()
      .references(() => organisations.id),
    body: text('body').notNull(),
    redactedAt: timestamp('redacted_at', { withTimezone: true }),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => ({ byThread: index('messages_thread_seq_idx').on(t.threadId, t.seq) }),
);

// Outbox for the transactional-outbox event bus (ARCHITECTURE.md §8).
export const outbox = pgTable('outbox', {
  id: uuid('id').primaryKey().defaultRandom(),
  eventType: text('event_type').notNull(),
  payload: jsonb('payload').notNull(),
  published: boolean('published').notNull().default(false),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
});
