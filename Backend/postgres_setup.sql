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
  user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  plan_tier TEXT NOT NULL,
  amount REAL NOT NULL,
  status TEXT NOT NULL DEFAULT 'pending',
  created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
  updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
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
