import prisma from '../../utils/prismaClient.js';
import { connectDb } from '../../db/init.js';

const ADMIN_EMAIL = 'austinrmz2007@gmail.com';

let dbReady = false;

export const setupTestDb = () => {
  beforeAll(async () => {
    process.env.NODE_ENV = 'test';

    if (!process.env.TEST_DATABASE_URL && !process.env.DATABASE_URL) {
      throw new Error(
        'Set TEST_DATABASE_URL (recommended) or DATABASE_URL before running backend tests.'
      );
    }

    await connectDb();
    dbReady = true;
  });

  afterEach(async () => {
    if (!dbReady) return;

    try {
      await prisma.paymentEvent.deleteMany();
      await prisma.subscription.deleteMany();
      await prisma.payment.deleteMany();
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
