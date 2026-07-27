x-- SQLite database schema and seed data for Teclia Academia

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
  plan_tier TEXT NOT NULL,
  amount REAL NOT NULL,
  status TEXT NOT NULL DEFAULT 'pending',
  created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
  updated_at DATETIME DEFAULT CURRENT_TIMESTAMP,
  FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE
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
