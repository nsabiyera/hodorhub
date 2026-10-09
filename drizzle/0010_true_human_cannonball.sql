CREATE TYPE "public"."agent_run_phase" AS ENUM('requirements', 'design', 'build', 'delivery');--> statement-breakpoint
CREATE TYPE "public"."agent_run_status" AS ENUM('authorized', 'running', 'awaiting_gate', 'paused', 'halted', 'completed', 'failed');--> statement-breakpoint
CREATE TYPE "public"."compute_pledge_status" AS ENUM('proposed', 'accepted', 'declined');--> statement-breakpoint
CREATE TYPE "public"."ledger_entry_type" AS ENUM('reserve', 'settle', 'release');--> statement-breakpoint
CREATE TYPE "public"."milestone_status" AS ENUM('pending', 'awaiting_review', 'approved', 'changes_requested', 'rejected');--> statement-breakpoint
CREATE TABLE "agent_delivery_runs" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"project_id" uuid NOT NULL,
	"charity_org_id" uuid NOT NULL,
	"corporation_org_id" uuid NOT NULL,
	"compute_pledge_id" uuid NOT NULL,
	"template_code" text NOT NULL,
	"provider" text DEFAULT 'fake' NOT NULL,
	"price_book_version" text NOT NULL,
	"status" "agent_run_status" DEFAULT 'authorized' NOT NULL,
	"current_phase" "agent_run_phase" DEFAULT 'requirements' NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "agent_steps" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"run_id" uuid NOT NULL,
	"phase" "agent_run_phase" NOT NULL,
	"role" text NOT NULL,
	"step_index" integer NOT NULL,
	"input_tokens" integer DEFAULT 0 NOT NULL,
	"output_tokens" integer DEFAULT 0 NOT NULL,
	"cost_minor" integer DEFAULT 0 NOT NULL,
	"status" text NOT NULL,
	"error" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "compute_pledges" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"project_id" uuid NOT NULL,
	"corporation_org_id" uuid NOT NULL,
	"template_code" text NOT NULL,
	"budget_currency" text DEFAULT 'GBP' NOT NULL,
	"budget_committed_minor" integer NOT NULL,
	"status" "compute_pledge_status" DEFAULT 'proposed' NOT NULL,
	"decided_by" uuid,
	"reason" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "compute_pledges_budget_positive" CHECK ("compute_pledges"."budget_committed_minor" > 0)
);
--> statement-breakpoint
CREATE TABLE "run_budget_ledger" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"run_id" uuid NOT NULL,
	"step_id" uuid,
	"entry_type" "ledger_entry_type" NOT NULL,
	"amount_minor" integer NOT NULL,
	"model" text,
	"input_tokens" integer,
	"output_tokens" integer,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "run_budgets" (
	"run_id" uuid PRIMARY KEY NOT NULL,
	"currency" text DEFAULT 'GBP' NOT NULL,
	"committed_minor" integer NOT NULL,
	"reserved_minor" integer DEFAULT 0 NOT NULL,
	"consumed_minor" integer DEFAULT 0 NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "run_budgets_within_ceiling" CHECK ("run_budgets"."consumed_minor" + "run_budgets"."reserved_minor" <= "run_budgets"."committed_minor"),
	CONSTRAINT "run_budgets_non_negative" CHECK ("run_budgets"."reserved_minor" >= 0 AND "run_budgets"."consumed_minor" >= 0)
);
--> statement-breakpoint
CREATE TABLE "run_milestones" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"run_id" uuid NOT NULL,
	"phase" "agent_run_phase" NOT NULL,
	"status" "milestone_status" DEFAULT 'pending' NOT NULL,
	"artifact_ref" text,
	"reviewer_user_id" uuid,
	"reason" text,
	"opened_at" timestamp with time zone,
	"decided_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "run_milestones_one_per_phase" UNIQUE("run_id","phase")
);
--> statement-breakpoint
ALTER TABLE "agent_delivery_runs" ADD CONSTRAINT "agent_delivery_runs_project_id_projects_id_fk" FOREIGN KEY ("project_id") REFERENCES "public"."projects"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "agent_delivery_runs" ADD CONSTRAINT "agent_delivery_runs_charity_org_id_organisations_id_fk" FOREIGN KEY ("charity_org_id") REFERENCES "public"."organisations"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "agent_delivery_runs" ADD CONSTRAINT "agent_delivery_runs_corporation_org_id_organisations_id_fk" FOREIGN KEY ("corporation_org_id") REFERENCES "public"."organisations"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "agent_delivery_runs" ADD CONSTRAINT "agent_delivery_runs_compute_pledge_id_compute_pledges_id_fk" FOREIGN KEY ("compute_pledge_id") REFERENCES "public"."compute_pledges"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "agent_steps" ADD CONSTRAINT "agent_steps_run_id_agent_delivery_runs_id_fk" FOREIGN KEY ("run_id") REFERENCES "public"."agent_delivery_runs"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "compute_pledges" ADD CONSTRAINT "compute_pledges_project_id_projects_id_fk" FOREIGN KEY ("project_id") REFERENCES "public"."projects"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "compute_pledges" ADD CONSTRAINT "compute_pledges_corporation_org_id_organisations_id_fk" FOREIGN KEY ("corporation_org_id") REFERENCES "public"."organisations"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "compute_pledges" ADD CONSTRAINT "compute_pledges_decided_by_users_id_fk" FOREIGN KEY ("decided_by") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "run_budget_ledger" ADD CONSTRAINT "run_budget_ledger_run_id_agent_delivery_runs_id_fk" FOREIGN KEY ("run_id") REFERENCES "public"."agent_delivery_runs"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "run_budgets" ADD CONSTRAINT "run_budgets_run_id_agent_delivery_runs_id_fk" FOREIGN KEY ("run_id") REFERENCES "public"."agent_delivery_runs"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "run_milestones" ADD CONSTRAINT "run_milestones_run_id_agent_delivery_runs_id_fk" FOREIGN KEY ("run_id") REFERENCES "public"."agent_delivery_runs"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "run_milestones" ADD CONSTRAINT "run_milestones_reviewer_user_id_users_id_fk" FOREIGN KEY ("reviewer_user_id") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "compute_pledges_one_accepted_per_project" ON "compute_pledges" USING btree ("project_id") WHERE "compute_pledges"."status" = 'accepted';