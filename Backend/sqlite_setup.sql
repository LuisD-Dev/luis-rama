-- SQLite database schema and seed data for Teclia Academia

CREATE TABLE IF NOT EXISTS users (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  email TEXT UNIQUE NOT NULL,
  password_hash TEXT NOT NULL,
  name TEXT NOT NULL,
  role TEXT DEFAULT 'student',
  avatar_url TEXT DEFAULT NULL,
  reset_pin TEXT DEFAULT NULL,
  reset_pin_expires_at DATETIME DEFAULT NULL,
  plan_tier TEXT DEFAULT NULL,
  created_at DATETIME DEFAULT CURRENT_TIMESTAMP
);

CREATE TABLE IF NOT EXISTS content (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  title TEXT NOT NULL,
  description TEXT,
  type TEXT NOT NULL,
  url TEXT NOT NULL,
  is_free INTEGER DEFAULT 0,
  plan_tier TEXT DEFAULT 'free',
  uploaded_by INTEGER NOT NULL,
  created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
  FOREIGN KEY (uploaded_by) REFERENCES users(id)
);

CREATE TABLE IF NOT EXISTS site_stats (
  key TEXT PRIMARY KEY,
  value INTEGER DEFAULT 0
);

CREATE TABLE IF NOT EXISTS payments (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  user_id INTEGER NOT NULL,
  amount INTEGER NOT NULL,
  currency TEXT NOT NULL DEFAULT 'usd',
  plan_tier TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'pending',
  provider TEXT NOT NULL DEFAULT 'stripe',
  external_id TEXT,
  payment_method_id TEXT,
  stripe_payment_intent_id TEXT UNIQUE,
  stripe_checkout_session_id TEXT UNIQUE,
  idempotency_key TEXT NOT NULL UNIQUE,
  metadata TEXT,
  created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at DATETIME NOT NULL,
  FOREIGN KEY (user_id) REFERENCES users(id)
);

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

CREATE TABLE IF NOT EXISTS payment_events (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  payment_id INTEGER,
  type TEXT NOT NULL,
  payload TEXT NOT NULL,
  processed_at DATETIME,
  idempotency_key TEXT NOT NULL UNIQUE,
  stripe_event_id TEXT UNIQUE,
  outcome TEXT,
  created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  FOREIGN KEY (payment_id) REFERENCES payments(id)
);

INSERT OR IGNORE INTO users (email, password_hash, name, role, plan_tier)
VALUES (
  'austinrmz2007@gmail.com',
  '$2a$10$f05LsZpUFUMV8IIUczvzWuaTH1wDx6cImBEFla1Rq0gNTu42jFVyW',
  'Austin',
  'admin',
  NULL
);

INSERT OR IGNORE INTO content (title, description, type, url, is_free, plan_tier, uploaded_by)
VALUES (
  'Getting Started with Teclia',
  'Sample free lesson for local development.',
  'video',
  'https://example.com/sample-video',
  1,
  'free',
  1
);

INSERT OR IGNORE INTO site_stats (key, value)
VALUES ('initial_setup', 1);
