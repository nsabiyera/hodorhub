CREATE TABLE "membership_profile_skills" (
	"membership_id" uuid NOT NULL,
	"skill_code" text NOT NULL,
	CONSTRAINT "membership_profile_skills_membership_id_skill_code_pk" PRIMARY KEY("membership_id","skill_code")
);
--> statement-breakpoint
CREATE TABLE "membership_profiles" (
	"membership_id" uuid PRIMARY KEY NOT NULL,
	"weekly_hours" integer NOT NULL,
	"seniority" text,
	"note" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "membership_profiles_weekly_hours" CHECK ("membership_profiles"."weekly_hours" between 0 and 168)
);
--> statement-breakpoint
ALTER TABLE "users" ADD COLUMN "display_name" text;--> statement-breakpoint
ALTER TABLE "membership_profile_skills" ADD CONSTRAINT "membership_profile_skills_membership_id_membership_profiles_membership_id_fk" FOREIGN KEY ("membership_id") REFERENCES "public"."membership_profiles"("membership_id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "membership_profiles" ADD CONSTRAINT "membership_profiles_membership_id_memberships_id_fk" FOREIGN KEY ("membership_id") REFERENCES "public"."memberships"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "membership_profile_skills_skill_idx" ON "membership_profile_skills" USING btree ("skill_code");--> statement-breakpoint
-- US-1.5 backfill, hand-written: drizzle-kit generates the constraint but not
-- the dedupe, and adding the constraint to duplicated rows fails with 23505.
--
-- One person, one workspace, one weekly commitment. A second row is not a
-- second commitment, it is a mistake or a re-allocation. The survivor is the
-- row with the LARGEST hours_per_week (tie-broken by id) so collapsing can
-- never silently REDUCE a capacity a charity is counting on.
--
-- Children must be repointed BEFORE the losers are deleted: both FKs are
-- ON DELETE no action, so skipping this fails with 23503 (loud, but it blocks
-- a deploy), and approved hours (US-6.2a) must certainly survive a schema change.
CREATE TEMPORARY TABLE alloc_dedupe AS
SELECT a.id AS loser_id, s.id AS survivor_id
FROM allocations a
JOIN (
  SELECT DISTINCT ON (delivery_workspace_id, volunteer_user_id)
         id, delivery_workspace_id, volunteer_user_id
  FROM allocations
  ORDER BY delivery_workspace_id, volunteer_user_id, hours_per_week DESC, id
) s
  ON s.delivery_workspace_id = a.delivery_workspace_id
 AND s.volunteer_user_id = a.volunteer_user_id
WHERE a.id <> s.id;
--> statement-breakpoint
UPDATE hour_logs h SET allocation_id = d.survivor_id
FROM alloc_dedupe d WHERE h.allocation_id = d.loser_id;
--> statement-breakpoint
UPDATE delivery_tasks t SET assigned_allocation_id = d.survivor_id
FROM alloc_dedupe d WHERE t.assigned_allocation_id = d.loser_id;
--> statement-breakpoint
DELETE FROM allocations a USING alloc_dedupe d WHERE a.id = d.loser_id;
--> statement-breakpoint
-- Plain CREATE UNIQUE INDEX, not CONCURRENTLY: drizzle wraps migrations in a
-- transaction and CONCURRENTLY cannot run inside one. Milliseconds at MVP
-- sizes; do NOT copy this pattern onto a large table without rethinking it.
ALTER TABLE "allocations" ADD CONSTRAINT "allocations_one_per_workspace" UNIQUE("delivery_workspace_id","volunteer_user_id");