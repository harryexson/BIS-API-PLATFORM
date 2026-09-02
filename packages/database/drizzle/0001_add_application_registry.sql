CREATE TABLE "application_permissions" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"application_id" uuid NOT NULL,
	"resource" text NOT NULL,
	"action" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "applications" ADD COLUMN "status" text DEFAULT 'active' NOT NULL;--> statement-breakpoint
ALTER TABLE "applications" ADD COLUMN "environment" text DEFAULT 'development' NOT NULL;--> statement-breakpoint
ALTER TABLE "applications" ADD COLUMN "allowed_capabilities" jsonb;--> statement-breakpoint
ALTER TABLE "applications" ADD COLUMN "metadata" jsonb;--> statement-breakpoint
ALTER TABLE "application_permissions" ADD CONSTRAINT "application_permissions_application_id_applications_id_fk" FOREIGN KEY ("application_id") REFERENCES "public"."applications"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "idx_app_perms_application_id" ON "application_permissions" USING btree ("application_id");--> statement-breakpoint
CREATE UNIQUE INDEX "idx_app_perms_application_resource_action" ON "application_permissions" USING btree ("application_id","resource","action");--> statement-breakpoint
CREATE INDEX "idx_applications_status" ON "applications" USING btree ("status");--> statement-breakpoint
CREATE INDEX "idx_applications_environment" ON "applications" USING btree ("environment");