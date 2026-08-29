CREATE TABLE "transactions" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"app_id" text NOT NULL,
	"tenant_id" text NOT NULL DEFAULT 'default',
	"provider_id" text NOT NULL,
	"provider_transaction_id" text,
	"status" text NOT NULL DEFAULT 'pending',
	"amount" numeric NOT NULL,
	"currency" text NOT NULL,
	"payment_method" text,
	"idempotency_key" text,
	"metadata" jsonb,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE INDEX "idx_transactions_app_id" ON "transactions" USING btree ("app_id");
--> statement-breakpoint
CREATE INDEX "idx_transactions_tenant_id" ON "transactions" USING btree ("tenant_id");
--> statement-breakpoint
CREATE INDEX "idx_transactions_provider_tx_id" ON "transactions" USING btree ("provider_transaction_id");
--> statement-breakpoint
CREATE INDEX "idx_transactions_status" ON "transactions" USING btree ("status");
