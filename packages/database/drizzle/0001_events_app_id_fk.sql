-- Seed the two sentinel "applications" this platform already writes into
-- events.app_id for events with no real owning tenant app — provider-level
-- events (provider_webhook processing, the reconciliation job) use
-- 'system'; a payment webhook whose payload carried no metadata.appId
-- falls back to 'webhook'. Real rows, not magic strings the FK below would
-- otherwise reject, so every events.app_id is a valid reference. Idempotent
-- (ON CONFLICT DO NOTHING) so re-running this file is harmless.
INSERT INTO "applications" ("name", "slug", "description", "status", "environment")
VALUES
  ('System', 'system', 'Sentinel application for provider-level events with no owning tenant app (provider webhook processing, reconciliation).', 'active', 'production'),
  ('Webhook (unattributed)', 'webhook', 'Sentinel application for a payment webhook whose payload carried no metadata.appId.', 'active', 'production')
ON CONFLICT ("slug") DO NOTHING;
--> statement-breakpoint
ALTER TABLE "events" ADD CONSTRAINT "events_app_id_applications_slug_fk" FOREIGN KEY ("app_id") REFERENCES "public"."applications"("slug") ON DELETE no action ON UPDATE no action;
