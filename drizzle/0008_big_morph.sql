CREATE TYPE "public"."digital_resource_kind" AS ENUM('cloud_credits', 'api_budget', 'llm_budget', 'saas_seats', 'hosting', 'domains', 'other');--> statement-breakpoint
CREATE TYPE "public"."resource_gift_status" AS ENUM('offered', 'accepted', 'declined', 'provided', 'received', 'withdrawn');--> statement-breakpoint
CREATE TABLE "digital_resource_needs" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"project_id" uuid NOT NULL,
	"kind" "digital_resource_kind" NOT NULL,
	"description" text,
	"quantity" integer,
	"unit" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "resource_gifts" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"project_id" uuid NOT NULL,
	"corporation_org_id" uuid NOT NULL,
	"need_id" uuid,
	"kind" "digital_resource_kind" NOT NULL,
	"quantity" integer,
	"unit" text,
	"note" text,
	"status" "resource_gift_status" DEFAULT 'offered' NOT NULL,
	"decided_by" uuid,
	"provided_at" timestamp with time zone,
	"received_at" timestamp with time zone,
	"reason" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "digital_resource_needs" ADD CONSTRAINT "digital_resource_needs_project_id_projects_id_fk" FOREIGN KEY ("project_id") REFERENCES "public"."projects"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "resource_gifts" ADD CONSTRAINT "resource_gifts_project_id_projects_id_fk" FOREIGN KEY ("project_id") REFERENCES "public"."projects"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "resource_gifts" ADD CONSTRAINT "resource_gifts_corporation_org_id_organisations_id_fk" FOREIGN KEY ("corporation_org_id") REFERENCES "public"."organisations"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "resource_gifts" ADD CONSTRAINT "resource_gifts_need_id_digital_resource_needs_id_fk" FOREIGN KEY ("need_id") REFERENCES "public"."digital_resource_needs"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "resource_gifts" ADD CONSTRAINT "resource_gifts_decided_by_users_id_fk" FOREIGN KEY ("decided_by") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;