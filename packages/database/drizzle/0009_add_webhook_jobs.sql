CREATE TABLE "webhook_jobs" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"job_type" text NOT NULL,
	"payload" jsonb NOT NULL,
	"status" text DEFAULT 'pending' NOT NULL,
	"attempts" integer DEFAULT 0 NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"processed_at" timestamp with time zone,
	"error" text
);
--> statement-breakpoint
CREATE INDEX "idx_webhook_jobs_status" ON "webhook_jobs" USING btree ("status");--> statement-breakpoint
CREATE INDEX "idx_webhook_jobs_created_at" ON "webhook_jobs" USING btree ("created_at");
