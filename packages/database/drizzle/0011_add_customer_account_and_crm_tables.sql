-- Adds the customer-account/subscription/CRM/messaging-compliance/webhook
-- tables that existed on claude/bis-api-platform-production-r9to5j but not
-- on main, as part of reconciling the two independently-evolved branches.
--
-- Hand-written rather than drizzle-kit-generated: this repo's own
-- drizzle/meta/ snapshot files for migrations 0002-0010 were never
-- committed (only .sql files were), so drizzle-kit's automatic diffing
-- against main's real migration history is unreliable — it cannot see
-- past migration 0001 and treats every table/column added since as new,
-- including ones that already exist (checkout_sessions, conversations,
-- events, idempotency_records, outbox_events, suppliers,
-- tenant_application_links, transactions, webhook_jobs, and the tenants
-- table's country_code/currency/status/metadata columns already added by
-- 0008_reconcile_schema_drift.sql). Every statement below was verified
-- against the actual committed .sql files (0000-0010), not the broken
-- snapshot chain, to confirm it is genuinely new.

CREATE TABLE "consent_records" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"app_id" text NOT NULL,
	"tenant_id" text DEFAULT 'default' NOT NULL,
	"recipient" text NOT NULL,
	"channel" text NOT NULL,
	"status" text NOT NULL,
	"source" text NOT NULL,
	"keyword" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE INDEX "idx_consent_app" ON "consent_records" USING btree ("app_id");
--> statement-breakpoint
CREATE INDEX "idx_consent_tenant" ON "consent_records" USING btree ("tenant_id");
--> statement-breakpoint
CREATE INDEX "idx_consent_recipient" ON "consent_records" USING btree ("recipient");
--> statement-breakpoint
CREATE UNIQUE INDEX "idx_consent_recipient_app_tenant_channel" ON "consent_records" USING btree ("recipient","app_id","tenant_id","channel");
--> statement-breakpoint
CREATE TABLE "customer_notes" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"application_id" uuid NOT NULL,
	"author_name" text NOT NULL,
	"body" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "customer_notes" ADD CONSTRAINT "customer_notes_application_id_applications_id_fk" FOREIGN KEY ("application_id") REFERENCES "public"."applications"("id") ON DELETE cascade ON UPDATE no action;
--> statement-breakpoint
CREATE INDEX "idx_customer_notes_application_id" ON "customer_notes" USING btree ("application_id");
--> statement-breakpoint
CREATE TABLE "messaging_profiles" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"app_id" text NOT NULL,
	"tenant_id" text DEFAULT 'default' NOT NULL,
	"country" text NOT NULL,
	"sender_type" text NOT NULL,
	"sender" text NOT NULL,
	"provider" text NOT NULL,
	"campaign_id" text,
	"brand_id" text,
	"compliance_status" text DEFAULT 'unregistered' NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE INDEX "idx_messaging_profiles_app" ON "messaging_profiles" USING btree ("app_id");
--> statement-breakpoint
CREATE INDEX "idx_messaging_profiles_tenant" ON "messaging_profiles" USING btree ("tenant_id");
--> statement-breakpoint
CREATE INDEX "idx_messaging_profiles_country" ON "messaging_profiles" USING btree ("country");
--> statement-breakpoint
CREATE INDEX "idx_messaging_profiles_compliance_status" ON "messaging_profiles" USING btree ("compliance_status");
--> statement-breakpoint
CREATE UNIQUE INDEX "idx_messaging_profiles_app_tenant_sender_provider" ON "messaging_profiles" USING btree ("app_id","tenant_id","sender","provider");
--> statement-breakpoint
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
CREATE TABLE "support_tickets" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"application_id" uuid NOT NULL,
	"subject" text NOT NULL,
	"description" text NOT NULL,
	"status" text DEFAULT 'open' NOT NULL,
	"priority" text DEFAULT 'normal' NOT NULL,
	"requester_email" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"resolved_at" timestamp with time zone
);
--> statement-breakpoint
ALTER TABLE "support_tickets" ADD CONSTRAINT "support_tickets_application_id_applications_id_fk" FOREIGN KEY ("application_id") REFERENCES "public"."applications"("id") ON DELETE cascade ON UPDATE no action;
--> statement-breakpoint
CREATE INDEX "idx_support_tickets_application_id" ON "support_tickets" USING btree ("application_id");
--> statement-breakpoint
CREATE INDEX "idx_support_tickets_status" ON "support_tickets" USING btree ("status");
--> statement-breakpoint
CREATE TABLE "ticket_comments" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"ticket_id" uuid NOT NULL,
	"author_name" text NOT NULL,
	"body" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "ticket_comments" ADD CONSTRAINT "ticket_comments_ticket_id_support_tickets_id_fk" FOREIGN KEY ("ticket_id") REFERENCES "public"."support_tickets"("id") ON DELETE cascade ON UPDATE no action;
--> statement-breakpoint
CREATE INDEX "idx_ticket_comments_ticket_id" ON "ticket_comments" USING btree ("ticket_id");
--> statement-breakpoint
CREATE TABLE "user_sessions" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"user_id" uuid NOT NULL,
	"token_hash" text NOT NULL,
	"user_agent" text,
	"ip_address" text,
	"expires_at" timestamp with time zone NOT NULL,
	"revoked_at" timestamp with time zone,
	"last_used_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "user_sessions_token_hash_unique" UNIQUE("token_hash")
);
--> statement-breakpoint
ALTER TABLE "user_sessions" ADD CONSTRAINT "user_sessions_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;
--> statement-breakpoint
CREATE INDEX "idx_user_sessions_user_id" ON "user_sessions" USING btree ("user_id");
--> statement-breakpoint
CREATE UNIQUE INDEX "idx_user_sessions_token_hash" ON "user_sessions" USING btree ("token_hash");
--> statement-breakpoint
CREATE TABLE "user_verification_tokens" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"user_id" uuid NOT NULL,
	"purpose" text NOT NULL,
	"token_hash" text NOT NULL,
	"expires_at" timestamp with time zone NOT NULL,
	"used_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "user_verification_tokens_token_hash_unique" UNIQUE("token_hash")
);
--> statement-breakpoint
ALTER TABLE "user_verification_tokens" ADD CONSTRAINT "user_verification_tokens_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;
--> statement-breakpoint
CREATE INDEX "idx_user_verification_tokens_user_id" ON "user_verification_tokens" USING btree ("user_id");
--> statement-breakpoint
CREATE UNIQUE INDEX "idx_user_verification_tokens_hash" ON "user_verification_tokens" USING btree ("token_hash");
--> statement-breakpoint
CREATE INDEX "idx_user_verification_tokens_purpose" ON "user_verification_tokens" USING btree ("purpose");
--> statement-breakpoint
CREATE TABLE "webhook_endpoints" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"app_id" text NOT NULL,
	"tenant_id" text DEFAULT 'default' NOT NULL,
	"url" text NOT NULL,
	"encrypted_secret" text NOT NULL,
	"secret_iv" text NOT NULL,
	"secret_tag" text NOT NULL,
	"event_types" jsonb DEFAULT '["*"]'::jsonb NOT NULL,
	"active" boolean DEFAULT true NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE INDEX "idx_webhook_endpoints_app" ON "webhook_endpoints" USING btree ("app_id");
--> statement-breakpoint
CREATE INDEX "idx_webhook_endpoints_tenant" ON "webhook_endpoints" USING btree ("tenant_id");
--> statement-breakpoint
CREATE INDEX "idx_webhook_endpoints_active" ON "webhook_endpoints" USING btree ("active");
--> statement-breakpoint

-- users: role_id (a user's role within their application — see roles.ts)
-- and a global-uniqueness index on email (signup/login are global — one
-- signup creates one application — tightening the pre-existing
-- per-application-only uniqueness; this table had no rows before this
-- change on the branch that authored it, so tightening was safe there —
-- re-verify row count is still zero, or that no duplicate emails exist
-- across applications, before running this against a real database with
-- existing users).
ALTER TABLE "users" ADD COLUMN "role_id" uuid;
--> statement-breakpoint
ALTER TABLE "users" ADD CONSTRAINT "users_role_id_roles_id_fk" FOREIGN KEY ("role_id") REFERENCES "public"."roles"("id") ON DELETE set null ON UPDATE no action;
--> statement-breakpoint
CREATE INDEX "idx_users_role_id" ON "users" USING btree ("role_id");
--> statement-breakpoint
CREATE UNIQUE INDEX "idx_users_email" ON "users" USING btree ("email");
--> statement-breakpoint

-- events.app_id -> applications.slug FK, closing a gap where events could
-- reference an application slug that doesn't exist. Seed the two sentinel
-- "applications" this platform already writes into events.app_id for
-- events with no real owning tenant app first — provider-level events
-- (provider_webhook processing, the reconciliation job) use 'system'; a
-- payment webhook whose payload carried no metadata.appId falls back to
-- 'webhook'. Idempotent (ON CONFLICT DO NOTHING) so re-running this file
-- is harmless.
INSERT INTO "applications" ("name", "slug", "description", "status", "environment")
VALUES
  ('System', 'system', 'Sentinel application for provider-level events with no owning tenant app (provider webhook processing, reconciliation).', 'active', 'production'),
  ('Webhook (unattributed)', 'webhook', 'Sentinel application for a payment webhook whose payload carried no metadata.appId.', 'active', 'production')
ON CONFLICT ("slug") DO NOTHING;
--> statement-breakpoint
ALTER TABLE "events" ADD CONSTRAINT "events_app_id_applications_slug_fk" FOREIGN KEY ("app_id") REFERENCES "public"."applications"("slug") ON DELETE no action ON UPDATE no action;
