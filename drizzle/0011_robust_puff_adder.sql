CREATE TYPE "public"."deployed_env_status" AS ENUM('deploying', 'live', 'failed', 'torn_down');--> statement-breakpoint
CREATE TYPE "public"."deployed_environment" AS ENUM('staging', 'production');--> statement-breakpoint
CREATE TABLE "deployed_environments" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"run_id" uuid NOT NULL,
	"environment" "deployed_environment" NOT NULL,
	"url" text,
	"revision_ref" text,
	"status" "deployed_env_status" DEFAULT 'deploying' NOT NULL,
	"deployed_at" timestamp with time zone,
	"torn_down_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "deployed_environments" ADD CONSTRAINT "deployed_environments_run_id_agent_delivery_runs_id_fk" FOREIGN KEY ("run_id") REFERENCES "public"."agent_delivery_runs"("id") ON DELETE no action ON UPDATE no action;