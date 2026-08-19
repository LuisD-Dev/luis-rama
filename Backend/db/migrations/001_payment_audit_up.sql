-- Forward: payment audit trail (SQL reference mirror of Prisma migration)
-- See Backend/prisma/migrations/20260720230001_payment_audit_trail/migration.sql

ALTER TABLE payments ADD COLUMN provider TEXT NOT NULL DEFAULT 'stripe';
ALTER TABLE payments ADD COLUMN external_id TEXT;
ALTER TABLE payments ADD COLUMN metadata TEXT;

CREATE INDEX IF NOT EXISTS payments_user_id_created_at_idx ON payments(user_id, created_at);

CREATE TABLE IF NOT EXISTS subscriptions (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  user_id INTEGER NOT NULL,
  plan_tier TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'active',
  provider TEXT NOT NULL DEFAULT 'stripe',
  external_id TEXT NOT NULL,
  current_period_start DATETIME NOT NULL,
  current_period_end DATETIME NOT NULL,
  created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at DATETIME NOT NULL,
  FOREIGN KEY (user_id) REFERENCES users(id)
);

CREATE UNIQUE INDEX IF NOT EXISTS subscriptions_provider_external_id_key
  ON subscriptions(provider, external_id);
