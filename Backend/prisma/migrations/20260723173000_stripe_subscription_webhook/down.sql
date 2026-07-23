-- Down: reverse Stripe subscription webhook support (SQL reference)

DROP TABLE IF EXISTS "audit_logs";
DROP INDEX IF EXISTS "users_stripe_customer_id_key";
ALTER TABLE "users" DROP COLUMN "stripe_customer_id";
