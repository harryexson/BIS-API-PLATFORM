-- Reconciles the live database schema with packages/database/src/schema/*.ts.
--
-- The `conversations` and `tenant_application_links` tables, and the current
-- shape of `tenants` (decoupled from a direct applications FK, with
-- country_code/currency/status/metadata) were added to the Drizzle schema at
-- some point after migration 0007 but a corresponding migration was never
-- generated. This was invisible because all existing tests run against a
-- mocked database. This migration brings a real database in line with the
-- schema the application code actually queries against.
CREATE TABLE "conversations" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"phone_number" text NOT NULL,
	"app_id" text NOT NULL,
	"tenant_id" text DEFAULT 'default' NOT NULL,
	"provider_id" text NOT NULL,
	"channel" text NOT NULL,
	"status" text DEFAULT 'active' NOT NULL,
	"last_message_at" timestamp with time zone DEFAULT now() NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE INDEX "idx_conversations_phone" ON "conversations" USING btree ("phone_number");--> statement-breakpoint
CREATE INDEX "idx_conversations_app" ON "conversations" USING btree ("app_id");--> statement-breakpoint
CREATE INDEX "idx_conversations_tenant" ON "conversations" USING btree ("tenant_id");--> statement-breakpoint
CREATE INDEX "idx_conversations_provider" ON "conversations" USING btree ("provider_id");--> statement-breakpoint
CREATE INDEX "idx_conversations_status" ON "conversations" USING btree ("status");--> statement-breakpoint
CREATE UNIQUE INDEX "idx_conversations_phone_app_tenant" ON "conversations" USING btree ("phone_number","app_id","tenant_id");--> statement-breakpoint
CREATE TABLE "tenant_application_links" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"tenant_id" uuid NOT NULL,
	"application_id" uuid NOT NULL,
	"status" text DEFAULT 'active' NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "tenant_application_links" ADD CONSTRAINT "tenant_application_links_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenants"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "tenant_application_links" ADD CONSTRAINT "tenant_application_links_application_id_applications_id_fk" FOREIGN KEY ("application_id") REFERENCES "public"."applications"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "idx_tenant_app_links_tenant_id" ON "tenant_application_links" USING btree ("tenant_id");--> statement-breakpoint
CREATE INDEX "idx_tenant_app_links_application_id" ON "tenant_application_links" USING btree ("application_id");--> statement-breakpoint
CREATE UNIQUE INDEX "idx_tenant_app_links_tenant_app" ON "tenant_application_links" USING btree ("tenant_id","application_id");--> statement-breakpoint
ALTER TABLE "tenants" DROP CONSTRAINT "tenants_application_id_applications_id_fk";--> statement-breakpoint
DROP INDEX IF EXISTS "idx_tenants_application_id";--> statement-breakpoint
DROP INDEX IF EXISTS "idx_tenants_application_slug";--> statement-breakpoint
ALTER TABLE "tenants" DROP COLUMN "application_id";--> statement-breakpoint
ALTER TABLE "tenants" DROP COLUMN "domain";--> statement-breakpoint
ALTER TABLE "tenants" DROP COLUMN "settings";--> statement-breakpoint
ALTER TABLE "tenants" ADD COLUMN "country_code" text;--> statement-breakpoint
ALTER TABLE "tenants" ADD COLUMN "currency" text;--> statement-breakpoint
ALTER TABLE "tenants" ADD COLUMN "status" text DEFAULT 'active' NOT NULL;--> statement-breakpoint
ALTER TABLE "tenants" ADD COLUMN "metadata" jsonb;--> statement-breakpoint
CREATE INDEX "idx_tenants_slug" ON "tenants" USING btree ("slug");--> statement-breakpoint
CREATE INDEX "idx_tenants_status" ON "tenants" USING btree ("status");--> statement-breakpoint
CREATE UNIQUE INDEX "idx_tenants_slug_status" ON "tenants" USING btree ("slug","status");
