-- Seed the subscription plan tiers advertised on apps/landing's pricing
-- section (#pricing) and selectable through apps/web's Plans & Billing page
-- (GET/POST /v1/api/billing/*). The `plans` table (packages/database/src/
-- schema/plans.ts, created in 0011) has existed with zero rows until now —
-- GET /v1/api/billing/plans returned an empty array and the "Subscribe"
-- flow had nothing to subscribe to.
--
-- Pricing: flat monthly tiers, not the landing page's previous "usage-based
-- per transaction" framing — the `plans` schema only supports a flat
-- recurring priceCents/interval, with messageLimit/paymentVolumeLimitCents
-- as an included monthly allowance, not a metered rate. These are real,
-- committed numbers (not a placeholder), chosen to match that model;
-- update this table (or add new plan rows) if pricing changes.
--
-- Enterprise is deliberately NOT a row here — apps/landing's Enterprise
-- tier links to "Contact sales" (#faq), not self-serve signup, so it has
-- no plan to subscribe to.
INSERT INTO "plans" ("slug", "name", "description", "price_cents", "currency", "interval", "message_limit", "payment_volume_limit_cents", "is_active")
VALUES
  ('free', 'Free', 'For testing and low volume — all 14 provider rails with sandbox credentials.', 0, 'USD', 'month', 500, 500000, true),
  ('growth', 'Growth', 'Production credentials with email support.', 4900, 'USD', 'month', 10000, 10000000, true),
  ('scale', 'Scale', 'Volume discounts and priority support for high-traffic applications.', 19900, 'USD', 'month', NULL, NULL, true)
ON CONFLICT ("slug") DO NOTHING;
