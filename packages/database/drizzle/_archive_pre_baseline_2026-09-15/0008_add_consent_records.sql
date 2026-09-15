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
