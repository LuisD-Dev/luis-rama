import prisma from '../utils/prismaClient.js';

const resolveDatabaseUrl = () => {
  if (process.env.NODE_ENV === 'test' && process.env.TEST_DATABASE_URL) {
    return process.env.TEST_DATABASE_URL;
  }
  return process.env.DATABASE_URL;
};

export const connectDb = async () => {
  const databaseUrl = resolveDatabaseUrl();

  if (!databaseUrl) {
    throw new Error(
      'DATABASE_URL is required. Configure your Supabase PostgreSQL connection string in Backend/.env'
    );
  }

  if (process.env.NODE_ENV === 'test' && process.env.TEST_DATABASE_URL) {
    process.env.DATABASE_URL = process.env.TEST_DATABASE_URL;
  }

  await prisma.$connect();
  // Ensure payments table exists for SQLite (handles fresh DB without migration run)
  // This is idempotent and safe for concurrent test runs.
  try {
    await prisma.$executeRawUnsafe(`
      CREATE TABLE IF NOT EXISTS "payments" (
        "id" INTEGER NOT NULL PRIMARY KEY AUTOINCREMENT,
        "user_id" INTEGER NOT NULL,
        "plan_tier" TEXT NOT NULL,
        "amount" INTEGER NOT NULL,
        "currency" TEXT NOT NULL DEFAULT 'usd',
        "status" TEXT NOT NULL,
        "code" TEXT NOT NULL,
        "idempotency_key" TEXT NOT NULL,
        "stripe_payment_intent_id" TEXT,
        "stripe_payment_method_id" TEXT,
        "client_message" TEXT,
        "created_at" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
        "updated_at" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
        CONSTRAINT "payments_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "users" ("id") ON DELETE RESTRICT ON UPDATE CASCADE
      )
    `);
    await prisma.$executeRawUnsafe(`CREATE UNIQUE INDEX IF NOT EXISTS "payments_user_id_idempotency_key_key" ON "payments"("user_id", "idempotency_key")`);
    await prisma.$executeRawUnsafe(`CREATE INDEX IF NOT EXISTS "payments_user_id_idx" ON "payments"("user_id")`);
  } catch (_) {
    // ignore for Postgres or already exists
  }
  console.log('✓ Database connected via Prisma');
};

export const initDb = connectDb;

export default { connectDb, initDb };
