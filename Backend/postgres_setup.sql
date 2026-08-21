-- PostgreSQL database schema and seed data for Teclia Academia

CREATE TABLE IF NOT EXISTS users (
  id SERIAL PRIMARY KEY,
  email TEXT UNIQUE NOT NULL,
  password_hash TEXT NOT NULL,
  name TEXT NOT NULL,
  role TEXT DEFAULT 'student',
  avatar_url TEXT,
  reset_pin TEXT,
  reset_pin_expires_at TIMESTAMP,
  plan_tier TEXT DEFAULT NULL,
  created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
);

CREATE TABLE IF NOT EXISTS content (
  id SERIAL PRIMARY KEY,
  title TEXT NOT NULL,
  description TEXT,
  type TEXT NOT NULL,
  url TEXT NOT NULL,
  is_free INTEGER DEFAULT 0,
  plan_tier TEXT DEFAULT 'free',
  uploaded_by INTEGER NOT NULL REFERENCES users(id),
  created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
);

CREATE TABLE IF NOT EXISTS site_stats (
  key TEXT PRIMARY KEY,
  value INTEGER DEFAULT 0
);

CREATE TABLE IF NOT EXISTS payments (
  id SERIAL PRIMARY KEY,
  user_id INTEGER NOT NULL REFERENCES users(id),
  amount INTEGER NOT NULL,
  currency TEXT NOT NULL DEFAULT 'usd',
  plan_tier TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'created',
  provider TEXT NOT NULL DEFAULT 'stripe',
  external_id TEXT,
  payment_method_id TEXT,
  stripe_payment_intent_id TEXT UNIQUE,
  stripe_checkout_session_id TEXT UNIQUE,
  idempotency_key TEXT NOT NULL UNIQUE,
  metadata TEXT,
  created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP
);

CREATE INDEX IF NOT EXISTS payments_user_id_created_at_idx ON payments(user_id, created_at);

CREATE TABLE IF NOT EXISTS subscriptions (
  id SERIAL PRIMARY KEY,
  user_id INTEGER NOT NULL REFERENCES users(id),
  plan_tier TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'active',
  provider TEXT NOT NULL DEFAULT 'stripe',
  external_id TEXT NOT NULL,
  current_period_start TIMESTAMP NOT NULL,
  current_period_end TIMESTAMP NOT NULL,
  created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
  UNIQUE (provider, external_id)
);

CREATE TABLE IF NOT EXISTS payment_events (
  id SERIAL PRIMARY KEY,
  payment_id INTEGER REFERENCES payments(id) ON DELETE SET NULL,
  type TEXT NOT NULL,
  payload TEXT NOT NULL,
  processed_at TIMESTAMP,
  idempotency_key TEXT NOT NULL UNIQUE,
  stripe_event_id TEXT UNIQUE,
  outcome TEXT,
  created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP
);

INSERT INTO users (email, password_hash, name, role, plan_tier)
VALUES (
  'austinrmz2007@gmail.com',
  '$2a$10$f05LsZpUFUMV8IIUczvzWuaTH1wDx6cImBEFla1Rq0gNTu42jFVyW',
  'Austin',
  'admin',
  NULL
)
ON CONFLICT (email) DO NOTHING;

INSERT INTO content (title, description, type, url, is_free, plan_tier, uploaded_by)
VALUES (
  'Getting Started with Teclia',
  'Sample free lesson for local development.',
  'video',
  'https://example.com/sample-video',
  1,
  'free',
  1
)
ON CONFLICT DO NOTHING;

INSERT INTO site_stats (key, value)
VALUES ('initial_setup', 1)
ON CONFLICT (key) DO NOTHING;
