-- Forward: Stripe subscription webhook support (SQL reference mirror of Prisma migration)
-- See Backend/prisma/migrations/20260723173000_stripe_subscription_webhook/migration.sql

ALTER TABLE users ADD COLUMN stripe_customer_id TEXT;

CREATE UNIQUE INDEX IF NOT EXISTS users_stripe_customer_id_key
  ON users(stripe_customer_id);

CREATE TABLE IF NOT EXISTS audit_logs (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  actor TEXT NOT NULL,
  action TEXT NOT NULL,
  entity_type TEXT NOT NULL,
  entity_id INTEGER,
  before_state TEXT,
  after_state TEXT,
  created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP
);
