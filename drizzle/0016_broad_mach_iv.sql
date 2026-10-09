CREATE TYPE "public"."delivery_milestone_status" AS ENUM('open', 'achieved');--> statement-breakpoint
CREATE TYPE "public"."delivery_task_status" AS ENUM('todo', 'in_progress', 'done');--> statement-breakpoint
CREATE TABLE "delivery_milestones" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"delivery_workspace_id" uuid NOT NULL,
	"title" text NOT NULL,
	"due_on" date,
	"status" "delivery_milestone_status" DEFAULT 'open' NOT NULL,
	"achieved_at" timestamp with time zone,
	"achieved_by" uuid,
	"created_by" uuid NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "delivery_tasks" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"delivery_workspace_id" uuid NOT NULL,
	"milestone_id" uuid,
	"title" text NOT NULL,
	"detail" text,
	"status" "delivery_task_status" DEFAULT 'todo' NOT NULL,
	"assigned_allocation_id" uuid,
	"completed_at" timestamp with time zone,
	"created_by" uuid NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "delivery_milestones" ADD CONSTRAINT "delivery_milestones_delivery_workspace_id_delivery_workspaces_id_fk" FOREIGN KEY ("delivery_workspace_id") REFERENCES "public"."delivery_workspaces"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "delivery_milestones" ADD CONSTRAINT "delivery_milestones_achieved_by_users_id_fk" FOREIGN KEY ("achieved_by") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "delivery_milestones" ADD CONSTRAINT "delivery_milestones_created_by_users_id_fk" FOREIGN KEY ("created_by") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "delivery_tasks" ADD CONSTRAINT "delivery_tasks_delivery_workspace_id_delivery_workspaces_id_fk" FOREIGN KEY ("delivery_workspace_id") REFERENCES "public"."delivery_workspaces"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "delivery_tasks" ADD CONSTRAINT "delivery_tasks_milestone_id_delivery_milestones_id_fk" FOREIGN KEY ("milestone_id") REFERENCES "public"."delivery_milestones"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "delivery_tasks" ADD CONSTRAINT "delivery_tasks_assigned_allocation_id_allocations_id_fk" FOREIGN KEY ("assigned_allocation_id") REFERENCES "public"."allocations"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "delivery_tasks" ADD CONSTRAINT "delivery_tasks_created_by_users_id_fk" FOREIGN KEY ("created_by") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;