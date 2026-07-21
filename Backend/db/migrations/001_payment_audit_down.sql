-- Down: reverse payment audit trail (SQL reference)
-- See Backend/prisma/migrations/20260720230001_payment_audit_trail/down.sql

DROP INDEX IF EXISTS subscriptions_provider_external_id_key;
DROP TABLE IF EXISTS subscriptions;
DROP INDEX IF EXISTS payments_user_id_created_at_idx;
