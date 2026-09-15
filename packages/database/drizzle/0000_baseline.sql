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
CREATE TABLE "application_permissions" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"application_id" uuid NOT NULL,
	"resource" text NOT NULL,
	"action" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "applications" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"name" text NOT NULL,
	"slug" text NOT NULL,
	"description" text,
	"status" text DEFAULT 'active' NOT NULL,
	"environment" text DEFAULT 'development' NOT NULL,
	"allowed_capabilities" jsonb,
	"metadata" jsonb,
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
CREATE TABLE "customer_notes" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"application_id" uuid NOT NULL,
	"author_name" text NOT NULL,
	"body" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "events" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"app_id" text NOT NULL,
	"tenant_id" text DEFAULT 'default',
	"category" text NOT NULL,
	"provider_id" text,
	"status" text NOT NULL,
	"amount" numeric,
	"currency" text,
	"latency" integer,
	"cost" numeric,
	"decision_reason" text,
	"payload" jsonb,
	"response" jsonb,
	"error" text,
	"idempotency_key" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "idempotency_records" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"app_id" text NOT NULL,
	"tenant_id" text DEFAULT 'default' NOT NULL,
	"operation" text NOT NULL,
	"idempotency_key" text NOT NULL,
	"status" text DEFAULT 'pending' NOT NULL,
	"result" jsonb,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"expires_at" timestamp with time zone NOT NULL
);
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
CREATE TABLE "outbox_events" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"app_id" text NOT NULL,
	"event_type" text NOT NULL,
	"payload" jsonb NOT NULL,
	"status" text DEFAULT 'pending' NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"processed_at" timestamp with time zone,
	"error" text
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
CREATE TABLE "suppliers" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"application_id" uuid NOT NULL,
	"tenant_id" text NOT NULL,
	"name" text NOT NULL,
	"slug" text NOT NULL,
	"type" text NOT NULL,
	"status" text DEFAULT 'active' NOT NULL,
	"metadata" jsonb,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
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
CREATE TABLE "tenant_application_links" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"tenant_id" uuid NOT NULL,
	"application_id" uuid NOT NULL,
	"status" text DEFAULT 'active' NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "tenants" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"name" text NOT NULL,
	"slug" text NOT NULL,
	"country_code" text,
	"currency" text,
	"status" text DEFAULT 'active' NOT NULL,
	"metadata" jsonb,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "ticket_comments" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"ticket_id" uuid NOT NULL,
	"author_name" text NOT NULL,
	"body" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "transactions" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"app_id" text NOT NULL,
	"tenant_id" text DEFAULT 'default' NOT NULL,
	"provider_id" text NOT NULL,
	"provider_transaction_id" text,
	"status" text DEFAULT 'pending' NOT NULL,
	"amount" numeric NOT NULL,
	"currency" text NOT NULL,
	"payment_method" text,
	"idempotency_key" text,
	"metadata" jsonb,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
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
CREATE TABLE "users" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"application_id" uuid NOT NULL,
	"tenant_id" uuid,
	"role_id" uuid,
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
ALTER TABLE "application_permissions" ADD CONSTRAINT "application_permissions_application_id_applications_id_fk" FOREIGN KEY ("application_id") REFERENCES "public"."applications"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "audit_logs" ADD CONSTRAINT "audit_logs_application_id_applications_id_fk" FOREIGN KEY ("application_id") REFERENCES "public"."applications"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "audit_logs" ADD CONSTRAINT "audit_logs_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "customer_notes" ADD CONSTRAINT "customer_notes_application_id_applications_id_fk" FOREIGN KEY ("application_id") REFERENCES "public"."applications"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "permissions" ADD CONSTRAINT "permissions_role_id_roles_id_fk" FOREIGN KEY ("role_id") REFERENCES "public"."roles"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "provider_capabilities" ADD CONSTRAINT "provider_capabilities_provider_id_providers_id_fk" FOREIGN KEY ("provider_id") REFERENCES "public"."providers"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "provider_configs" ADD CONSTRAINT "provider_configs_provider_id_providers_id_fk" FOREIGN KEY ("provider_id") REFERENCES "public"."providers"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "provider_health" ADD CONSTRAINT "provider_health_provider_id_providers_id_fk" FOREIGN KEY ("provider_id") REFERENCES "public"."providers"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "roles" ADD CONSTRAINT "roles_application_id_applications_id_fk" FOREIGN KEY ("application_id") REFERENCES "public"."applications"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "subscriptions" ADD CONSTRAINT "subscriptions_application_id_applications_id_fk" FOREIGN KEY ("application_id") REFERENCES "public"."applications"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "subscriptions" ADD CONSTRAINT "subscriptions_plan_id_plans_id_fk" FOREIGN KEY ("plan_id") REFERENCES "public"."plans"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "suppliers" ADD CONSTRAINT "suppliers_application_id_applications_id_fk" FOREIGN KEY ("application_id") REFERENCES "public"."applications"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "support_tickets" ADD CONSTRAINT "support_tickets_application_id_applications_id_fk" FOREIGN KEY ("application_id") REFERENCES "public"."applications"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "tenant_application_links" ADD CONSTRAINT "tenant_application_links_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenants"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "tenant_application_links" ADD CONSTRAINT "tenant_application_links_application_id_applications_id_fk" FOREIGN KEY ("application_id") REFERENCES "public"."applications"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "ticket_comments" ADD CONSTRAINT "ticket_comments_ticket_id_support_tickets_id_fk" FOREIGN KEY ("ticket_id") REFERENCES "public"."support_tickets"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "user_sessions" ADD CONSTRAINT "user_sessions_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "user_verification_tokens" ADD CONSTRAINT "user_verification_tokens_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "users" ADD CONSTRAINT "users_application_id_applications_id_fk" FOREIGN KEY ("application_id") REFERENCES "public"."applications"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "users" ADD CONSTRAINT "users_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenants"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "users" ADD CONSTRAINT "users_role_id_roles_id_fk" FOREIGN KEY ("role_id") REFERENCES "public"."roles"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "idx_api_keys_application_id" ON "application_api_keys" USING btree ("application_id");--> statement-breakpoint
CREATE INDEX "idx_api_keys_prefix" ON "application_api_keys" USING btree ("prefix");--> statement-breakpoint
CREATE UNIQUE INDEX "idx_api_keys_hash" ON "application_api_keys" USING btree ("key_hash");--> statement-breakpoint
CREATE INDEX "idx_app_perms_application_id" ON "application_permissions" USING btree ("application_id");--> statement-breakpoint
CREATE UNIQUE INDEX "idx_app_perms_application_resource_action" ON "application_permissions" USING btree ("application_id","resource","action");--> statement-breakpoint
CREATE INDEX "idx_applications_name" ON "applications" USING btree ("name");--> statement-breakpoint
CREATE INDEX "idx_applications_slug" ON "applications" USING btree ("slug");--> statement-breakpoint
CREATE INDEX "idx_applications_status" ON "applications" USING btree ("status");--> statement-breakpoint
CREATE INDEX "idx_applications_environment" ON "applications" USING btree ("environment");--> statement-breakpoint
CREATE INDEX "idx_audit_logs_application_id" ON "audit_logs" USING btree ("application_id");--> statement-breakpoint
CREATE INDEX "idx_audit_logs_user_id" ON "audit_logs" USING btree ("user_id");--> statement-breakpoint
CREATE INDEX "idx_audit_logs_action" ON "audit_logs" USING btree ("action");--> statement-breakpoint
CREATE INDEX "idx_audit_logs_resource" ON "audit_logs" USING btree ("resource");--> statement-breakpoint
CREATE INDEX "idx_audit_logs_created_at" ON "audit_logs" USING btree ("created_at");--> statement-breakpoint
CREATE INDEX "idx_consent_app" ON "consent_records" USING btree ("app_id");--> statement-breakpoint
CREATE INDEX "idx_consent_tenant" ON "consent_records" USING btree ("tenant_id");--> statement-breakpoint
CREATE INDEX "idx_consent_recipient" ON "consent_records" USING btree ("recipient");--> statement-breakpoint
CREATE UNIQUE INDEX "idx_consent_recipient_app_tenant_channel" ON "consent_records" USING btree ("recipient","app_id","tenant_id","channel");--> statement-breakpoint
CREATE INDEX "idx_conversations_phone" ON "conversations" USING btree ("phone_number");--> statement-breakpoint
CREATE INDEX "idx_conversations_app" ON "conversations" USING btree ("app_id");--> statement-breakpoint
CREATE INDEX "idx_conversations_tenant" ON "conversations" USING btree ("tenant_id");--> statement-breakpoint
CREATE INDEX "idx_conversations_provider" ON "conversations" USING btree ("provider_id");--> statement-breakpoint
CREATE INDEX "idx_conversations_status" ON "conversations" USING btree ("status");--> statement-breakpoint
CREATE UNIQUE INDEX "idx_conversations_phone_app_tenant" ON "conversations" USING btree ("phone_number","app_id","tenant_id");--> statement-breakpoint
CREATE INDEX "idx_customer_notes_application_id" ON "customer_notes" USING btree ("application_id");--> statement-breakpoint
CREATE INDEX "idx_events_app_id" ON "events" USING btree ("app_id");--> statement-breakpoint
CREATE INDEX "idx_events_tenant_id" ON "events" USING btree ("tenant_id");--> statement-breakpoint
CREATE INDEX "idx_events_category" ON "events" USING btree ("category");--> statement-breakpoint
CREATE INDEX "idx_events_provider_id" ON "events" USING btree ("provider_id");--> statement-breakpoint
CREATE INDEX "idx_events_created_at" ON "events" USING btree ("created_at");--> statement-breakpoint
CREATE UNIQUE INDEX "idx_idempotency_composite" ON "idempotency_records" USING btree ("app_id","tenant_id","operation","idempotency_key");--> statement-breakpoint
CREATE INDEX "idx_messaging_profiles_app" ON "messaging_profiles" USING btree ("app_id");--> statement-breakpoint
CREATE INDEX "idx_messaging_profiles_tenant" ON "messaging_profiles" USING btree ("tenant_id");--> statement-breakpoint
CREATE INDEX "idx_messaging_profiles_country" ON "messaging_profiles" USING btree ("country");--> statement-breakpoint
CREATE INDEX "idx_messaging_profiles_compliance_status" ON "messaging_profiles" USING btree ("compliance_status");--> statement-breakpoint
CREATE UNIQUE INDEX "idx_messaging_profiles_app_tenant_sender_provider" ON "messaging_profiles" USING btree ("app_id","tenant_id","sender","provider");--> statement-breakpoint
CREATE INDEX "idx_outbox_status" ON "outbox_events" USING btree ("status");--> statement-breakpoint
CREATE INDEX "idx_outbox_created_at" ON "outbox_events" USING btree ("created_at");--> statement-breakpoint
CREATE INDEX "idx_permissions_role_id" ON "permissions" USING btree ("role_id");--> statement-breakpoint
CREATE UNIQUE INDEX "idx_permissions_role_resource_action" ON "permissions" USING btree ("role_id","resource","action");--> statement-breakpoint
CREATE UNIQUE INDEX "idx_plans_slug" ON "plans" USING btree ("slug");--> statement-breakpoint
CREATE INDEX "idx_plans_is_active" ON "plans" USING btree ("is_active");--> statement-breakpoint
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
CREATE UNIQUE INDEX "idx_subscriptions_application_id" ON "subscriptions" USING btree ("application_id");--> statement-breakpoint
CREATE INDEX "idx_subscriptions_plan_id" ON "subscriptions" USING btree ("plan_id");--> statement-breakpoint
CREATE INDEX "idx_subscriptions_status" ON "subscriptions" USING btree ("status");--> statement-breakpoint
CREATE UNIQUE INDEX "idx_subscriptions_stripe_subscription_id" ON "subscriptions" USING btree ("stripe_subscription_id");--> statement-breakpoint
CREATE INDEX "idx_suppliers_application_id" ON "suppliers" USING btree ("application_id");--> statement-breakpoint
CREATE UNIQUE INDEX "idx_suppliers_application_slug" ON "suppliers" USING btree ("application_id","tenant_id","slug");--> statement-breakpoint
CREATE INDEX "idx_support_tickets_application_id" ON "support_tickets" USING btree ("application_id");--> statement-breakpoint
CREATE INDEX "idx_support_tickets_status" ON "support_tickets" USING btree ("status");--> statement-breakpoint
CREATE INDEX "idx_tenant_app_links_tenant_id" ON "tenant_application_links" USING btree ("tenant_id");--> statement-breakpoint
CREATE INDEX "idx_tenant_app_links_application_id" ON "tenant_application_links" USING btree ("application_id");--> statement-breakpoint
CREATE UNIQUE INDEX "idx_tenant_app_links_tenant_app" ON "tenant_application_links" USING btree ("tenant_id","application_id");--> statement-breakpoint
CREATE INDEX "idx_tenants_slug" ON "tenants" USING btree ("slug");--> statement-breakpoint
CREATE INDEX "idx_tenants_status" ON "tenants" USING btree ("status");--> statement-breakpoint
CREATE UNIQUE INDEX "idx_tenants_slug_status" ON "tenants" USING btree ("slug","status");--> statement-breakpoint
CREATE INDEX "idx_ticket_comments_ticket_id" ON "ticket_comments" USING btree ("ticket_id");--> statement-breakpoint
CREATE INDEX "idx_transactions_app_id" ON "transactions" USING btree ("app_id");--> statement-breakpoint
CREATE INDEX "idx_transactions_tenant_id" ON "transactions" USING btree ("tenant_id");--> statement-breakpoint
CREATE INDEX "idx_transactions_provider_tx_id" ON "transactions" USING btree ("provider_transaction_id");--> statement-breakpoint
CREATE INDEX "idx_transactions_status" ON "transactions" USING btree ("status");--> statement-breakpoint
CREATE UNIQUE INDEX "idx_transactions_idempotency" ON "transactions" USING btree ("app_id","tenant_id","idempotency_key");--> statement-breakpoint
CREATE INDEX "idx_user_sessions_user_id" ON "user_sessions" USING btree ("user_id");--> statement-breakpoint
CREATE UNIQUE INDEX "idx_user_sessions_token_hash" ON "user_sessions" USING btree ("token_hash");--> statement-breakpoint
CREATE INDEX "idx_user_verification_tokens_user_id" ON "user_verification_tokens" USING btree ("user_id");--> statement-breakpoint
CREATE UNIQUE INDEX "idx_user_verification_tokens_hash" ON "user_verification_tokens" USING btree ("token_hash");--> statement-breakpoint
CREATE INDEX "idx_user_verification_tokens_purpose" ON "user_verification_tokens" USING btree ("purpose");--> statement-breakpoint
CREATE INDEX "idx_users_application_id" ON "users" USING btree ("application_id");--> statement-breakpoint
CREATE INDEX "idx_users_tenant_id" ON "users" USING btree ("tenant_id");--> statement-breakpoint
CREATE INDEX "idx_users_role_id" ON "users" USING btree ("role_id");--> statement-breakpoint
CREATE UNIQUE INDEX "idx_users_application_email" ON "users" USING btree ("application_id","email");--> statement-breakpoint
CREATE UNIQUE INDEX "idx_users_email" ON "users" USING btree ("email");