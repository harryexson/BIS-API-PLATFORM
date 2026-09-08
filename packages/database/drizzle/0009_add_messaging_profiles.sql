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
