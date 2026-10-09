ALTER TABLE "subscriptions" ADD COLUMN "customer_ref" text;--> statement-breakpoint
ALTER TABLE "subscriptions" ADD COLUMN "subscription_ref" text;--> statement-breakpoint
ALTER TABLE "subscriptions" ADD COLUMN "created_at" timestamp with time zone DEFAULT now() NOT NULL;--> statement-breakpoint
ALTER TABLE "subscriptions" ADD COLUMN "updated_at" timestamp with time zone DEFAULT now() NOT NULL;