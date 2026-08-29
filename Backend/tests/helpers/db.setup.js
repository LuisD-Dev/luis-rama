import prisma from '../../utils/prismaClient.js';
import { connectDb } from '../../db/init.js';

const ADMIN_EMAIL = 'austinrmz2007@gmail.com';

let dbReady = false;

const ensurePaymentsTable = async () => {
  const dbUrl = process.env.TEST_DATABASE_URL || process.env.DATABASE_URL || '';
  const isPostgres = dbUrl.startsWith('postgres://') || dbUrl.startsWith('postgresql://');

  if (isPostgres) {
    await prisma.$executeRawUnsafe(`
      CREATE TABLE IF NOT EXISTS payments (
        id SERIAL PRIMARY KEY,
        user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
        plan_tier TEXT NOT NULL,
        amount REAL NOT NULL,
        status TEXT NOT NULL DEFAULT 'created',
        created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
        updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
      )
    `);

    try {
      await prisma.$executeRawUnsafe('ALTER TABLE payments ADD COLUMN updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP');
    } catch (_e) {
      // column already exists
    }
    return;
  }

  await prisma.$executeRawUnsafe(`
    CREATE TABLE IF NOT EXISTS payments (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      user_id INTEGER NOT NULL,
      plan_tier TEXT NOT NULL,
      amount REAL NOT NULL,
      status TEXT NOT NULL DEFAULT 'created',
      created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
      updated_at DATETIME DEFAULT CURRENT_TIMESTAMP,
      FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE
    )
  `);

  try {
    await prisma.$executeRawUnsafe('ALTER TABLE payments ADD COLUMN updated_at DATETIME DEFAULT CURRENT_TIMESTAMP');
  } catch (_e) {
    // column already exists
  }
};

const ensureAuditTable = async () => {
  const dbUrl = process.env.TEST_DATABASE_URL || process.env.DATABASE_URL || '';
  const isPostgres = dbUrl.startsWith('postgres://') || dbUrl.startsWith('postgresql://');
  const timestampType = isPostgres ? 'TIMESTAMP' : 'DATETIME';
  await prisma.$executeRawUnsafe(`
    CREATE TABLE IF NOT EXISTS admin_audit_events (
      id TEXT PRIMARY KEY,
      actor_user_id INTEGER NOT NULL,
      action TEXT NOT NULL,
      target_type TEXT NOT NULL,
      target_id TEXT NOT NULL,
      request_id TEXT,
      ip_hash TEXT,
      before_json TEXT,
      after_json TEXT,
      prev_hash TEXT NOT NULL,
      entry_hash TEXT NOT NULL UNIQUE,
      created_at ${timestampType} NOT NULL DEFAULT CURRENT_TIMESTAMP
    )
  `);
};

export const setupTestDb = () => {
  beforeAll(async () => {
    process.env.NODE_ENV = 'test';

    if (!process.env.TEST_DATABASE_URL && !process.env.DATABASE_URL) {
      throw new Error(
        'Set TEST_DATABASE_URL (recommended) or DATABASE_URL before running backend tests.'
      );
    }

    await connectDb();
    await ensurePaymentsTable();
    await ensureAuditTable();
    dbReady = true;
  });

  afterEach(async () => {
    if (!dbReady) return;

    try {
      await prisma.riskDecision.deleteMany().catch(()=>{});
      await prisma.paymentEvent.deleteMany();
      await prisma.subscription.deleteMany();
      await prisma.payment.deleteMany();
      await prisma.adminAuditEvent.deleteMany();
      await prisma.content.deleteMany();
      await prisma.siteStat.deleteMany();
      await prisma.user.deleteMany({
        where: {
          NOT: {
            email: { equals: ADMIN_EMAIL },
          },
        },
      });
    } catch (_e) {
      // ignore cleanup errors between tests
    }
  });

  afterAll(async () => {
    if (dbReady) {
      await prisma.$disconnect();
    }
  });
};

export const promoteUserToAdmin = async (email) => {
  return prisma.user.updateMany({
    where: { email: { equals: email } },
    data: { role: 'admin' },
  });
};
