CREATE TABLE "user_roles" (
	"user_id" uuid NOT NULL,
	"role_id" uuid NOT NULL,
	"assigned_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "user_roles_user_id_role_id_pk" PRIMARY KEY("user_id","role_id")
);
--> statement-breakpoint
ALTER TABLE "user_roles" ADD CONSTRAINT "user_roles_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;
--> statement-breakpoint
ALTER TABLE "user_roles" ADD CONSTRAINT "user_roles_role_id_roles_id_fk" FOREIGN KEY ("role_id") REFERENCES "public"."roles"("id") ON DELETE cascade ON UPDATE no action;
--> statement-breakpoint
CREATE INDEX "idx_user_roles_user_id" ON "user_roles" USING btree ("user_id");
--> statement-breakpoint
CREATE INDEX "idx_user_roles_role_id" ON "user_roles" USING btree ("role_id");
--> statement-breakpoint
CREATE TABLE "subscription_plans" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"slug" text NOT NULL,
	"name" text NOT NULL,
	"description" text,
	"price_cents" integer NOT NULL,
	"currency" text DEFAULT 'USD' NOT NULL,
	"billing_interval" text DEFAULT 'month' NOT NULL,
	"features" jsonb,
	"is_active" boolean DEFAULT true NOT NULL,
	"stripe_product_id" text,
	"stripe_price_id" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "subscription_plans_slug_unique" UNIQUE("slug")
);
--> statement-breakpoint
CREATE INDEX "idx_subscription_plans_active" ON "subscription_plans" USING btree ("is_active");
--> statement-breakpoint
CREATE UNIQUE INDEX "idx_subscription_plans_slug" ON "subscription_plans" USING btree ("slug");
--> statement-breakpoint
CREATE TABLE "tenant_subscriptions" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"app_id" text NOT NULL,
	"tenant_id" text DEFAULT 'default' NOT NULL,
	"plan_id" uuid NOT NULL,
	"status" text DEFAULT 'trialing' NOT NULL,
	"current_period_start" timestamp with time zone DEFAULT now() NOT NULL,
	"current_period_end" timestamp with time zone,
	"cancel_at_period_end" timestamp with time zone,
	"stripe_customer_id" text,
	"stripe_subscription_id" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "tenant_subscriptions" ADD CONSTRAINT "tenant_subscriptions_plan_id_subscription_plans_id_fk" FOREIGN KEY ("plan_id") REFERENCES "public"."subscription_plans"("id") ON DELETE restrict ON UPDATE no action;
--> statement-breakpoint
CREATE INDEX "idx_tenant_subscriptions_app_id" ON "tenant_subscriptions" USING btree ("app_id");
--> statement-breakpoint
CREATE INDEX "idx_tenant_subscriptions_status" ON "tenant_subscriptions" USING btree ("status");
--> statement-breakpoint
CREATE UNIQUE INDEX "idx_tenant_subscriptions_app_tenant" ON "tenant_subscriptions" USING btree ("app_id","tenant_id");
--> statement-breakpoint
CREATE TABLE "support_tickets" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"app_id" text NOT NULL,
	"tenant_id" text DEFAULT 'default' NOT NULL,
	"requester_email" text NOT NULL,
	"subject" text NOT NULL,
	"status" text DEFAULT 'open' NOT NULL,
	"priority" text DEFAULT 'normal' NOT NULL,
	"external_provider" text,
	"external_ref" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"resolved_at" timestamp with time zone
);
--> statement-breakpoint
CREATE INDEX "idx_support_tickets_app_id" ON "support_tickets" USING btree ("app_id");
--> statement-breakpoint
CREATE INDEX "idx_support_tickets_tenant_id" ON "support_tickets" USING btree ("tenant_id");
--> statement-breakpoint
CREATE INDEX "idx_support_tickets_status" ON "support_tickets" USING btree ("status");
--> statement-breakpoint
CREATE TABLE "support_ticket_messages" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"ticket_id" uuid NOT NULL,
	"author_type" text NOT NULL,
	"author_email" text,
	"body" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "support_ticket_messages" ADD CONSTRAINT "support_ticket_messages_ticket_id_support_tickets_id_fk" FOREIGN KEY ("ticket_id") REFERENCES "public"."support_tickets"("id") ON DELETE cascade ON UPDATE no action;
--> statement-breakpoint
CREATE INDEX "idx_support_ticket_messages_ticket_id" ON "support_ticket_messages" USING btree ("ticket_id");
--> statement-breakpoint
CREATE TABLE "access_credentials" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"app_id" text NOT NULL,
	"tenant_id" text DEFAULT 'default' NOT NULL,
	"token" text NOT NULL,
	"credential_type" text DEFAULT 'qr' NOT NULL,
	"purpose" text NOT NULL,
	"owner_type" text NOT NULL,
	"owner_ref" text NOT NULL,
	"label" text,
	"status" text DEFAULT 'active' NOT NULL,
	"metadata" jsonb,
	"issued_at" timestamp with time zone DEFAULT now() NOT NULL,
	"expires_at" timestamp with time zone,
	"revoked_at" timestamp with time zone
);
--> statement-breakpoint
CREATE UNIQUE INDEX "idx_access_credentials_token" ON "access_credentials" USING btree ("token");
--> statement-breakpoint
CREATE INDEX "idx_access_credentials_app_id" ON "access_credentials" USING btree ("app_id");
--> statement-breakpoint
CREATE INDEX "idx_access_credentials_tenant_id" ON "access_credentials" USING btree ("tenant_id");
--> statement-breakpoint
CREATE INDEX "idx_access_credentials_owner" ON "access_credentials" USING btree ("owner_type","owner_ref");
--> statement-breakpoint
CREATE INDEX "idx_access_credentials_status" ON "access_credentials" USING btree ("status");
--> statement-breakpoint
CREATE TABLE "credential_scans" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"credential_id" uuid,
	"app_id" text NOT NULL,
	"tenant_id" text DEFAULT 'default' NOT NULL,
	"result" text NOT NULL,
	"scanned_by" text,
	"device_info" text,
	"metadata" jsonb,
	"scanned_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "credential_scans" ADD CONSTRAINT "credential_scans_credential_id_access_credentials_id_fk" FOREIGN KEY ("credential_id") REFERENCES "public"."access_credentials"("id") ON DELETE set null ON UPDATE no action;
--> statement-breakpoint
CREATE INDEX "idx_credential_scans_credential_id" ON "credential_scans" USING btree ("credential_id");
--> statement-breakpoint
CREATE INDEX "idx_credential_scans_app_id" ON "credential_scans" USING btree ("app_id");
--> statement-breakpoint
CREATE INDEX "idx_credential_scans_scanned_at" ON "credential_scans" USING btree ("scanned_at");
