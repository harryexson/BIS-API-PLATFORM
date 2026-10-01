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
CREATE INDEX "idx_webhook_endpoints_app" ON "webhook_endpoints" USING btree ("app_id");--> statement-breakpoint
CREATE INDEX "idx_webhook_endpoints_tenant" ON "webhook_endpoints" USING btree ("tenant_id");--> statement-breakpoint
CREATE INDEX "idx_webhook_endpoints_active" ON "webhook_endpoints" USING btree ("active");