# Database Seeding & Fixtures

This document describes the database seeding system for Teclia Academia, which provides a clean, reproducible way to populate the database with seed data for development and testing.

---

## Table of Contents

1. [Prerequisites & Setup](#prerequisites--setup)
2. [Running Seeds](#running-seeds)
3. [Resetting the Database](#resetting-the-database)
4. [Seed Data & Sample Credentials](#seed-data--sample-credentials)
5. [How Idempotency Works](#how-idempotency-works)
6. [Database Support](#database-support)
7. [Troubleshooting](#troubleshooting)

---

## Prerequisites & Setup

### Environment Setup

1. Ensure your `.env` file is configured with a `DATABASE_URL`:

   ```bash
   # For SQLite (local development):
   DATABASE_URL=sqlite:./dev.db
   
   # For PostgreSQL:
   DATABASE_URL=postgresql://user:password@localhost:5432/teclia_db
   ```

2. Set `NODE_ENV` for safe operations (db:reset refuses to run in production):

   ```bash
   NODE_ENV=development
   ```

3. Ensure all dependencies are installed:

   ```bash
   npm install
   ```

### Installation

The seeding system is built into the Teclia Academia backend and requires no additional setup beyond installing dependencies.

---

## Running Seeds

### Initial Seed

To populate an empty or existing database with seed data:

```bash
cd Backend
npm run db:seed
```

Or from the root directory:

```bash
npm run --prefix Backend db:seed
```

**Output:**
```
🌱 Starting database seed...

🔸 Using SQLite database...
🌱 Seeding users...
  ✓ User "Admin User" (admin@teclia.dev) seeded successfully
  ✓ User "Student One" (student1@teclia.dev) seeded successfully
  ✓ User "Student Two" (student2@teclia.dev) seeded successfully
✅ Users seeding complete
🌱 Seeding content...
  ✓ Content "Piano Basics - Getting Started" (video) seeded successfully
  ✓ Content "Advanced Piano Techniques" (video) seeded successfully
  ...
✅ Content seeding complete
✅ Database seed completed successfully!
```

**What it does:**

1. Detects your database type (SQLite or PostgreSQL) from `DATABASE_URL`
2. Creates tables if they don't exist
3. Inserts seed users (admin + 2 students)
4. Inserts 6+ content records (videos, articles, quizzes)
5. Saves the database (SQLite only)

**Idempotent behavior:**

- If users/content already exist (by unique email/title), they are **skipped**, not duplicated
- You can run this command multiple times safely
- The script exits with code 0 (success) or 1 (error)

---

## Resetting the Database

### WARNING: Dangerous Operation ⚠️

`db:reset` will **truncate all seeded tables** and re-populate them from scratch.

**It will refuse to run if `NODE_ENV=production`.**

```bash
cd Backend
npm run db:reset
```

**Process:**

1. ✅ Checks that `NODE_ENV !== 'production'`
2. 🗑️ Truncates tables in reverse dependency order: `content` → `users`
3. 🌱 Calls `db:seed` to re-populate
4. ✅ Complete database is fresh and re-seeded

**Example:**

```bash
$ npm run db:reset

⚠️  DANGEROUS OPERATION: This will truncate your database tables.

🔸 Using SQLite database...
🗑️  Truncating tables in reverse dependency order: content → users

✓ Tables truncated successfully

🌱 Running seed to re-populate database...

[seed output follows...]
✅ Database reset and re-seeded successfully!
```

---

## Seed Data & Sample Credentials

### Users

| Name | Email | Password | Role | Purpose |
|------|-------|----------|------|---------|
| Admin User | admin@teclia.dev | Admin1234! | admin | Full system access, can upload content, manage users |
| Student One | student1@teclia.dev | Student1234! | student | Regular student account for testing student features |
| Student Two | student2@teclia.dev | Student1234! | student | Additional student account for multi-user testing |

### ⚠️ IMPORTANT: Local Development Only

These credentials are **hardcoded seed data for local development only**:

- ❌ **DO NOT** use these in production
- ❌ **DO NOT** commit real credentials to the repository
- ❌ **DO NOT** share the repository if it contains production seeds

For production deployments:
- Generate strong random passwords
- Use environment-specific seed files
- Store credentials securely (vault, secrets manager, etc.)

### Content

The seeding system inserts 6+ content records across three types:

**Videos (2 records):**

- "Piano Basics - Getting Started" — free, beginner level
- "Advanced Piano Techniques" — basico tier

**Articles (2 records):**

- "Understanding Music Theory Fundamentals" — free
- "Jazz Improvisation Guide" — basico tier

**Quizzes (2 records):**

- "Music Theory Basics Quiz" — free
- "Intermediate Piano Skills Assessment" — basico tier

All content is authored by the admin user (`admin@teclia.dev`).

Canonical content plan tiers: free < basico < pro < master.
Legacy premium values are treated as basico during migration and compatibility checks.

---

## How Idempotency Works

### Users Seeder

**SQLite:**

```sql
INSERT OR IGNORE INTO users (email, password_hash, name, role, plan_tier, created_at)
VALUES (?, ?, ?, ?, NULL, CURRENT_TIMESTAMP)
```

The `OR IGNORE` clause skips insertion if the email already exists (unique constraint).

**PostgreSQL:**

```sql
INSERT INTO users (email, password_hash, name, role, plan_tier, created_at)
VALUES ($1, $2, $3, $4, NULL, CURRENT_TIMESTAMP)
ON CONFLICT (email) DO NOTHING
```

The `ON CONFLICT ... DO NOTHING` achieves the same result.

### Content Seeder

The same pattern applies:

- **SQLite:** `INSERT OR IGNORE`
- **PostgreSQL:** `ON CONFLICT DO NOTHING`

Conflicts are based on unique keys (email for users, url/title for content depending on implementation).

### Skipping Already-Seeded Records

When a record already exists, the seeder logs:

```
⏭️  User "Admin User" (admin@teclia.dev) already exists, skipping
```

This ensures:
- ✅ **Safe re-runs:** Running `npm run db:seed` multiple times won't duplicate data
- ✅ **Clean logs:** You can see which records were inserted vs. skipped
- ✅ **No errors:** Missing foreign keys or constraint violations won't crash the process

---

## Database Support

### SQLite

**Default for development:**

- Database file: `./dev.db` (from `DATABASE_URL=sqlite:./dev.db`)
- Idempotency: `INSERT OR IGNORE`
- Transaction: Tables auto-created if missing

**Example .env:**

```bash
DATABASE_URL=sqlite:./dev.db
NODE_ENV=development
```

### PostgreSQL

**For staging/production environments:**

- Connection: `postgresql://user:password@host:port/database`
- Idempotency: `ON CONFLICT DO NOTHING`
- Transaction: Tables must exist or be created by migrations

**Example .env:**

```bash
DATABASE_URL=postgresql://postgres:password@localhost:5432/teclia_db
NODE_ENV=staging
```

**Setup PostgreSQL:**

```bash
# Start PostgreSQL service
sudo service postgresql start

# Create database
createdb teclia_db

# Run seed
npm run db:seed
```

### Database Detection

The seeder automatically detects your database:

```javascript
if (databaseUrl.startsWith('postgres://') || databaseUrl.startsWith('postgresql://')) {
  // Use PostgreSQL
} else if (databaseUrl.startsWith('sqlite:')) {
  // Use SQLite
}
```

**No additional configuration needed** — just set `DATABASE_URL` correctly.

---

## Troubleshooting

### Error: `DATABASE_URL environment variable is not set`

**Solution:** Set `DATABASE_URL` in your `.env` file:

```bash
echo "DATABASE_URL=sqlite:./dev.db" >> .env
npm run db:seed
```

### Error: `db:reset is not allowed in production`

**Solution:** This is intentional! Production data is precious. To disable this protection:

```bash
NODE_ENV=development npm run db:reset
```

Or update your `.env`:

```bash
NODE_ENV=development
```

### SQLite: `UNABLE TO OPEN DATABASE FILE`

**Solution:** Ensure the directory exists:

```bash
mkdir -p ./data
DATABASE_URL=sqlite:./data/dev.db npm run db:seed
```

### PostgreSQL: `Connection refused`

**Solution:** Verify PostgreSQL is running:

```bash
# Check if PostgreSQL is running
psql -U postgres -h localhost -p 5432

# If not, start it:
# On macOS:
brew services start postgresql

# On Linux:
sudo service postgresql start

# On Windows:
# Start from Services app or: pg_ctl -D "C:\Program Files\PostgreSQL\15\data" start
```

### Content seeding fails with foreign key error

**Cause:** Admin user not created successfully

**Solution:** Check users seeding output and run again:

```bash
npm run db:seed
```

The users seeder always runs first and must succeed before content seeding begins.

### Duplicate key error (still occurs)

**Cause:** Race condition or concurrent seed processes

**Solution:** Ensure only one seed process is running:

```bash
# Kill any background seeds
pkill -f "node.*seed.js"

# Run fresh
npm run db:seed
```

---

## Integration with Tests

Use the fixtures in `Backend/tests/fixtures/` with your test suite:

```javascript
import { adminUser, studentUser } from '../fixtures/users.js';
import { pianoBasicsVideo, theoryBasicsQuiz } from '../fixtures/content.js';

describe('Content API', () => {
  it('should allow admins to upload content', async () => {
    // Use fixture data
    const admin = adminUser;
    // ... test logic
  });
});
```

Fixtures are **plain JavaScript objects** (no database calls), making them:
- Fast to import
- Easy to use in isolation
- Suitable for unit and integration tests

---

## Best Practices

✅ **DO:**

- Use `npm run db:seed` after cloning the repository
- Use `npm run db:reset` to start fresh during development
- Keep seed data minimal and focused on testing common scenarios
- Update fixtures whenever seed data changes
- Document changes to seed data in this file

❌ **DON'T:**

- Use production credentials in seeds
- Store large files or images in seed data
- Run `db:reset` in production
- Commit `.env` files with real secrets
- Use hardcoded IDs — always reference by email or unique fields

---

## Questions or Issues?

For detailed implementation, see:

- [Backend/scripts/seed.js](../scripts/seed.js) — Main seed orchestrator
- [Backend/scripts/reset.js](../scripts/reset.js) — Reset script with safety checks
- [Backend/scripts/seeders/users.seeder.js](../scripts/seeders/users.seeder.js) — User seeding logic
- [Backend/scripts/seeders/content.seeder.js](../scripts/seeders/content.seeder.js) — Content seeding logic
- [Backend/tests/fixtures/users.js](../tests/fixtures/users.js) — User fixtures
- [Backend/tests/fixtures/content.js](../tests/fixtures/content.js) — Content fixtures
