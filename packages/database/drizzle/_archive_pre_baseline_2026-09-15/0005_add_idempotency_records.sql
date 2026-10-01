CREATE TABLE "idempotency_records" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"app_id" text NOT NULL,
	"tenant_id" text NOT NULL DEFAULT 'default',
	"operation" text NOT NULL,
	"idempotency_key" text NOT NULL,
	"status" text NOT NULL DEFAULT 'pending',
	"result" jsonb,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"expires_at" timestamp with time zone NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX "idx_idempotency_composite" ON "idempotency_records" USING btree ("app_id", "tenant_id", "operation", "idempotency_key");
