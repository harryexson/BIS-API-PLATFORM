CREATE TABLE "events" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"app_id" text NOT NULL,
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
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE INDEX "idx_events_app_id" ON "events" USING btree ("app_id");
--> statement-breakpoint
CREATE INDEX "idx_events_category" ON "events" USING btree ("category");
--> statement-breakpoint
CREATE INDEX "idx_events_provider_id" ON "events" USING btree ("provider_id");
--> statement-breakpoint
CREATE INDEX "idx_events_created_at" ON "events" USING btree ("created_at");
