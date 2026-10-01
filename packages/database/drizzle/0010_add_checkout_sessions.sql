CREATE TABLE "checkout_sessions" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"token" text NOT NULL,
	"app_id" text NOT NULL,
	"tenant_id" text DEFAULT 'default' NOT NULL,
	"amount" numeric NOT NULL,
	"currency" text NOT NULL,
	"status" text DEFAULT 'pending' NOT NULL,
	"success_url" text,
	"cancel_url" text,
	"payment_event_id" text,
	"metadata" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"expires_at" timestamp with time zone NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX "idx_checkout_sessions_token" ON "checkout_sessions" USING btree ("token");--> statement-breakpoint
CREATE INDEX "idx_checkout_sessions_app_id" ON "checkout_sessions" USING btree ("app_id");--> statement-breakpoint
CREATE INDEX "idx_checkout_sessions_status" ON "checkout_sessions" USING btree ("status");
