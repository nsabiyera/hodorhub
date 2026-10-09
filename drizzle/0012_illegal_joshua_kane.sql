CREATE TABLE "platform_controls" (
	"id" uuid PRIMARY KEY NOT NULL,
	"agent_delivery_paused" boolean DEFAULT false NOT NULL,
	"updated_by" uuid,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "platform_controls_singleton" CHECK ("platform_controls"."id" = '00000000-0000-0000-0000-000000000001'::uuid)
);
--> statement-breakpoint
ALTER TABLE "platform_controls" ADD CONSTRAINT "platform_controls_updated_by_users_id_fk" FOREIGN KEY ("updated_by") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;