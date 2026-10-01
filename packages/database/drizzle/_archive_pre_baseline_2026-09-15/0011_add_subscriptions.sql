CREATE TABLE "plans" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"slug" text NOT NULL,
	"name" text NOT NULL,
	"description" text,
	"price_cents" integer NOT NULL,
	"currency" text DEFAULT 'USD' NOT NULL,
	"interval" text DEFAULT 'month' NOT NULL,
	"message_limit" integer,
	"payment_volume_limit_cents" integer,
	"stripe_price_id" text,
	"is_active" boolean DEFAULT true NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "plans_slug_unique" UNIQUE("slug")
);
--> statement-breakpoint
CREATE UNIQUE INDEX "idx_plans_slug" ON "plans" USING btree ("slug");
--> statement-breakpoint
CREATE INDEX "idx_plans_is_active" ON "plans" USING btree ("is_active");
--> statement-breakpoint
CREATE TABLE "subscriptions" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"application_id" uuid NOT NULL,
	"plan_id" uuid NOT NULL,
	"status" text DEFAULT 'active' NOT NULL,
	"stripe_customer_id" text,
	"stripe_subscription_id" text,
	"current_period_start" timestamp with time zone,
	"current_period_end" timestamp with time zone,
	"cancel_at_period_end" boolean DEFAULT false NOT NULL,
	"canceled_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "subscriptions" ADD CONSTRAINT "subscriptions_application_id_applications_id_fk" FOREIGN KEY ("application_id") REFERENCES "public"."applications"("id") ON DELETE cascade ON UPDATE no action;
--> statement-breakpoint
ALTER TABLE "subscriptions" ADD CONSTRAINT "subscriptions_plan_id_plans_id_fk" FOREIGN KEY ("plan_id") REFERENCES "public"."plans"("id") ON DELETE restrict ON UPDATE no action;
--> statement-breakpoint
CREATE UNIQUE INDEX "idx_subscriptions_application_id" ON "subscriptions" USING btree ("application_id");
--> statement-breakpoint
CREATE INDEX "idx_subscriptions_plan_id" ON "subscriptions" USING btree ("plan_id");
--> statement-breakpoint
CREATE INDEX "idx_subscriptions_status" ON "subscriptions" USING btree ("status");
--> statement-breakpoint
CREATE UNIQUE INDEX "idx_subscriptions_stripe_subscription_id" ON "subscriptions" USING btree ("stripe_subscription_id");
--> statement-breakpoint
-- Seed plans: placeholder pricing/limits for a real subscription-billing
-- mechanism, not a business decision about actual prices — see the
-- comment in packages/database/src/schema/plans.ts.
INSERT INTO "plans" ("slug", "name", "description", "price_cents", "currency", "interval", "message_limit", "payment_volume_limit_cents", "is_active") VALUES
	('starter', 'Starter', 'Free tier for evaluating the platform.', 0, 'USD', 'month', 1000, 500000, true),
	('growth', 'Growth', 'For applications with active production traffic.', 4900, 'USD', 'month', 25000, 5000000, true),
	('enterprise', 'Enterprise', 'Unlimited usage, dedicated support.', 19900, 'USD', 'month', NULL, NULL, true);
