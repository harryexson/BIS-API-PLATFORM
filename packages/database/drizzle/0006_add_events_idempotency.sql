ALTER TABLE "events" ADD COLUMN "idempotency_key" text;
--> statement-breakpoint
ALTER TABLE "events" ADD COLUMN "tenant_id" text DEFAULT 'default';
--> statement-breakpoint
CREATE INDEX "idx_events_tenant_id" ON "events" USING btree ("tenant_id");
