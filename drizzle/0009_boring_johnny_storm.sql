ALTER TABLE "resource_gifts" DROP CONSTRAINT "resource_gifts_need_id_digital_resource_needs_id_fk";
--> statement-breakpoint
ALTER TABLE "resource_gifts" ADD CONSTRAINT "resource_gifts_need_id_digital_resource_needs_id_fk" FOREIGN KEY ("need_id") REFERENCES "public"."digital_resource_needs"("id") ON DELETE set null ON UPDATE no action;