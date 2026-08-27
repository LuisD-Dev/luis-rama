-- Down: reverse Stripe subscription webhook support (SQL reference)
-- See Backend/prisma/migrations/20260723173000_stripe_subscription_webhook/down.sql

DROP TABLE IF EXISTS audit_logs;
DROP INDEX IF EXISTS users_stripe_customer_id_key;
ALTER TABLE users DROP COLUMN stripe_customer_id;
