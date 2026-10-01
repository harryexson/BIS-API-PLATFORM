CREATE TABLE "application_api_keys" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"application_id" uuid NOT NULL,
	"key_hash" text NOT NULL,
	"prefix" text NOT NULL,
	"environment" text DEFAULT 'test' NOT NULL,
	"scopes" text,
	"last_used_at" timestamp with time zone,
	"expires_at" timestamp with time zone,
	"revoked_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "application_api_keys_key_hash_unique" UNIQUE("key_hash")
);
--> statement-breakpoint
CREATE TABLE "applications" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"name" text NOT NULL,
	"slug" text NOT NULL,
	"description" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "applications_name_unique" UNIQUE("name"),
	CONSTRAINT "applications_slug_unique" UNIQUE("slug")
);
--> statement-breakpoint
CREATE TABLE "audit_logs" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"application_id" uuid,
	"user_id" uuid,
	"action" text NOT NULL,
	"resource" text NOT NULL,
	"resource_id" text,
	"details" text,
	"ip_address" text,
	"user_agent" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "permissions" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"role_id" uuid NOT NULL,
	"resource" text NOT NULL,
	"action" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "provider_capabilities" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"provider_id" uuid NOT NULL,
	"capability" text NOT NULL,
	"currencies" text,
	"payment_methods" text,
	"countries" text,
	"max_amount" text,
	"min_amount" text,
	"fee_percent" text,
	"fee_flat" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "provider_configs" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"provider_id" uuid NOT NULL,
	"environment" text DEFAULT 'test' NOT NULL,
	"encrypted_secret" text,
	"secret_iv" text,
	"secret_tag" text,
	"publishable_key" text,
	"webhook_secret" text,
	"additional_config" text,
	"weight" integer DEFAULT 50 NOT NULL,
	"latency_min" integer DEFAULT 100 NOT NULL,
	"latency_max" integer DEFAULT 200 NOT NULL,
	"enabled" text DEFAULT 'true' NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "provider_health" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"provider_id" uuid NOT NULL,
	"check_type" text NOT NULL,
	"status" text NOT NULL,
	"latency_ms" integer,
	"error_message" text,
	"checked_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "providers" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"slug" text NOT NULL,
	"name" text NOT NULL,
	"category" text NOT NULL,
	"status" text DEFAULT 'online' NOT NULL,
	"description" text,
	"base_url" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "providers_slug_unique" UNIQUE("slug")
);
--> statement-breakpoint
CREATE TABLE "roles" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"application_id" uuid NOT NULL,
	"name" text NOT NULL,
	"description" text,
	"is_system" text DEFAULT 'false' NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "tenants" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"application_id" uuid NOT NULL,
	"name" text NOT NULL,
	"slug" text NOT NULL,
	"domain" text,
	"settings" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "users" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"application_id" uuid NOT NULL,
	"tenant_id" uuid,
	"email" text NOT NULL,
	"name" text,
	"password_hash" text,
	"email_verified_at" timestamp with time zone,
	"last_login_at" timestamp with time zone,
	"failed_login_attempts" integer DEFAULT 0 NOT NULL,
	"locked_until_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "application_api_keys" ADD CONSTRAINT "application_api_keys_application_id_applications_id_fk" FOREIGN KEY ("application_id") REFERENCES "public"."applications"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "audit_logs" ADD CONSTRAINT "audit_logs_application_id_applications_id_fk" FOREIGN KEY ("application_id") REFERENCES "public"."applications"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "audit_logs" ADD CONSTRAINT "audit_logs_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "permissions" ADD CONSTRAINT "permissions_role_id_roles_id_fk" FOREIGN KEY ("role_id") REFERENCES "public"."roles"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "provider_capabilities" ADD CONSTRAINT "provider_capabilities_provider_id_providers_id_fk" FOREIGN KEY ("provider_id") REFERENCES "public"."providers"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "provider_configs" ADD CONSTRAINT "provider_configs_provider_id_providers_id_fk" FOREIGN KEY ("provider_id") REFERENCES "public"."providers"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "provider_health" ADD CONSTRAINT "provider_health_provider_id_providers_id_fk" FOREIGN KEY ("provider_id") REFERENCES "public"."providers"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "roles" ADD CONSTRAINT "roles_application_id_applications_id_fk" FOREIGN KEY ("application_id") REFERENCES "public"."applications"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "tenants" ADD CONSTRAINT "tenants_application_id_applications_id_fk" FOREIGN KEY ("application_id") REFERENCES "public"."applications"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "users" ADD CONSTRAINT "users_application_id_applications_id_fk" FOREIGN KEY ("application_id") REFERENCES "public"."applications"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "users" ADD CONSTRAINT "users_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenants"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "idx_api_keys_application_id" ON "application_api_keys" USING btree ("application_id");--> statement-breakpoint
CREATE INDEX "idx_api_keys_prefix" ON "application_api_keys" USING btree ("prefix");--> statement-breakpoint
CREATE UNIQUE INDEX "idx_api_keys_hash" ON "application_api_keys" USING btree ("key_hash");--> statement-breakpoint
CREATE INDEX "idx_applications_name" ON "applications" USING btree ("name");--> statement-breakpoint
CREATE INDEX "idx_applications_slug" ON "applications" USING btree ("slug");--> statement-breakpoint
CREATE INDEX "idx_audit_logs_application_id" ON "audit_logs" USING btree ("application_id");--> statement-breakpoint
CREATE INDEX "idx_audit_logs_user_id" ON "audit_logs" USING btree ("user_id");--> statement-breakpoint
CREATE INDEX "idx_audit_logs_action" ON "audit_logs" USING btree ("action");--> statement-breakpoint
CREATE INDEX "idx_audit_logs_resource" ON "audit_logs" USING btree ("resource");--> statement-breakpoint
CREATE INDEX "idx_audit_logs_created_at" ON "audit_logs" USING btree ("created_at");--> statement-breakpoint
CREATE INDEX "idx_permissions_role_id" ON "permissions" USING btree ("role_id");--> statement-breakpoint
CREATE UNIQUE INDEX "idx_permissions_role_resource_action" ON "permissions" USING btree ("role_id","resource","action");--> statement-breakpoint
CREATE INDEX "idx_provider_capabilities_provider_id" ON "provider_capabilities" USING btree ("provider_id");--> statement-breakpoint
CREATE UNIQUE INDEX "idx_provider_capabilities_provider_capability" ON "provider_capabilities" USING btree ("provider_id","capability");--> statement-breakpoint
CREATE INDEX "idx_provider_configs_provider_id" ON "provider_configs" USING btree ("provider_id");--> statement-breakpoint
CREATE UNIQUE INDEX "idx_provider_configs_provider_env" ON "provider_configs" USING btree ("provider_id","environment");--> statement-breakpoint
CREATE INDEX "idx_provider_health_provider_id" ON "provider_health" USING btree ("provider_id");--> statement-breakpoint
CREATE INDEX "idx_provider_health_provider_checked" ON "provider_health" USING btree ("provider_id","checked_at");--> statement-breakpoint
CREATE INDEX "idx_providers_slug" ON "providers" USING btree ("slug");--> statement-breakpoint
CREATE INDEX "idx_providers_category" ON "providers" USING btree ("category");--> statement-breakpoint
CREATE INDEX "idx_providers_status" ON "providers" USING btree ("status");--> statement-breakpoint
CREATE INDEX "idx_roles_application_id" ON "roles" USING btree ("application_id");--> statement-breakpoint
CREATE UNIQUE INDEX "idx_roles_application_name" ON "roles" USING btree ("application_id","name");--> statement-breakpoint
CREATE INDEX "idx_tenants_application_id" ON "tenants" USING btree ("application_id");--> statement-breakpoint
CREATE UNIQUE INDEX "idx_tenants_application_slug" ON "tenants" USING btree ("application_id","slug");--> statement-breakpoint
CREATE INDEX "idx_users_application_id" ON "users" USING btree ("application_id");--> statement-breakpoint
CREATE INDEX "idx_users_tenant_id" ON "users" USING btree ("tenant_id");--> statement-breakpoint
CREATE UNIQUE INDEX "idx_users_application_email" ON "users" USING btree ("application_id","email");