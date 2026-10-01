CREATE TABLE "outbox_events" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"app_id" text NOT NULL,
	"event_type" text NOT NULL,
	"payload" jsonb NOT NULL,
	"status" text NOT NULL DEFAULT 'pending',
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"processed_at" timestamp with time zone,
	"error" text
);
--> statement-breakpoint
CREATE INDEX "idx_outbox_status" ON "outbox_events" USING btree ("status");
--> statement-breakpoint
CREATE INDEX "idx_outbox_created_at" ON "outbox_events" USING btree ("created_at");
