import { jest } from '@jest/globals';
import prisma from '../utils/prismaClient.js';
import { setupTestDb } from './helpers/db.setup.js';
import {
  migrateLegacyPaymentStatuses,
  runPaymentStatusMigrationCli,
} from '../scripts/migratePaymentStatuses.js';

setupTestDb();

let fixtureSequence = 0;

const seedPayments = async (statuses) => {
  fixtureSequence += 1;
  const user = await prisma.user.create({
    data: {
      name: `Migration User ${fixtureSequence}`,
      email: `payment-status-migration-${fixtureSequence}@example.com`,
      passwordHash: 'hashed-password',
    },
  });

  const payments = [];
  for (const [index, status] of statuses.entries()) {
    payments.push(await prisma.payment.create({
      data: {
        userId: user.id,
        amount: 1000 + index,
        planTier: 'pro',
        status,
        idempotencyKey: `payment-status-${fixtureSequence}-${status}-${index}`,
      },
    }));
  }
  return payments;
};

describe('legacy Payment.status migration utility', () => {
  test('dry run reports legacy counts and changes no rows', async () => {
    const payments = await seedPayments([
      'created',
      'pending',
      'processing',
      'succeeded',
      'failed',
      'canceled',
      'completed',
      'processed',
    ]);

    const result = await migrateLegacyPaymentStatuses(prisma, { apply: false });

    expect(result).toMatchObject({
      mode: 'dry-run',
      updatedCount: 0,
      before: {
        completed: 1,
        processed: 1,
        otherNoncanonical: 0,
      },
    });
    const stored = await prisma.payment.findMany({
      where: { id: { in: payments.map((payment) => payment.id) } },
      orderBy: { id: 'asc' },
    });
    expect(stored.map((payment) => payment.status)).toEqual([
      'created',
      'pending',
      'processing',
      'succeeded',
      'failed',
      'canceled',
      'completed',
      'processed',
    ]);
  });

  test('apply converts only legacy success rows and is idempotent', async () => {
    const originalStatuses = [
      'created',
      'pending',
      'processing',
      'succeeded',
      'failed',
      'canceled',
      'completed',
      'processed',
    ];
    const payments = await seedPayments(originalStatuses);

    const first = await migrateLegacyPaymentStatuses(prisma, { apply: true });
    expect(first).toMatchObject({
      mode: 'apply',
      updatedCount: 2,
      legacyCleared: true,
      hasUnknownStatuses: false,
      success: true,
      after: { completed: 0, processed: 0, otherNoncanonical: 0 },
    });

    const afterFirst = await prisma.payment.findMany({
      where: { id: { in: payments.map((payment) => payment.id) } },
      orderBy: { id: 'asc' },
    });
    expect(afterFirst.map((payment) => payment.status)).toEqual([
      'created',
      'pending',
      'processing',
      'succeeded',
      'failed',
      'canceled',
      'succeeded',
      'succeeded',
    ]);

    const second = await migrateLegacyPaymentStatuses(prisma, { apply: true });
    expect(second).toMatchObject({
      updatedCount: 0,
      legacyCleared: true,
      hasUnknownStatuses: false,
      success: true,
    });
    const afterSecond = await prisma.payment.findMany({
      where: { id: { in: payments.map((payment) => payment.id) } },
      orderBy: { id: 'asc' },
    });
    expect(afterSecond).toEqual(afterFirst);
  });

  test('apply preserves unknown statuses, reports them, and makes the CLI fail', async () => {
    const payments = await seedPayments([
      'completed',
      'processed',
      'mystery_status',
    ]);

    const result = await migrateLegacyPaymentStatuses(prisma, { apply: true });
    expect(result).toMatchObject({
      updatedCount: 2,
      legacyCleared: true,
      hasUnknownStatuses: true,
      success: false,
      after: {
        completed: 0,
        processed: 0,
        otherNoncanonical: 1,
        unknownStatuses: [{ status: 'mystery_status', count: 1 }],
      },
    });

    const stored = await prisma.payment.findMany({
      where: { id: { in: payments.map((payment) => payment.id) } },
      orderBy: { id: 'asc' },
    });
    expect(stored.map((payment) => payment.status)).toEqual([
      'succeeded',
      'succeeded',
      'mystery_status',
    ]);

    const exitCode = await runPaymentStatusMigrationCli(
      ['--apply'],
      { db: prisma, stdout: jest.fn(), stderr: jest.fn() }
    );
    expect(exitCode).toBe(1);
  });

  test('CLI requires an explicit mode and does not write without one', async () => {
    const [payment] = await seedPayments(['completed']);
    const stderr = jest.fn();

    const exitCode = await runPaymentStatusMigrationCli(
      [],
      { db: prisma, stdout: jest.fn(), stderr }
    );

    expect(exitCode).toBe(2);
    expect(stderr).toHaveBeenCalledWith(
      'Usage: node scripts/migratePaymentStatuses.js --dry-run|--apply'
    );
    await expect(
      prisma.payment.findUnique({ where: { id: payment.id } })
    ).resolves.toMatchObject({ status: 'completed' });
  });

  test('disposable SQLite schema and raw inserts use created as the default', async () => {
    const columns = await prisma.$queryRawUnsafe(
      "SELECT dflt_value FROM pragma_table_info('payments') WHERE name = 'status'"
    );
    expect(columns).toEqual([{ dflt_value: "'created'" }]);

    fixtureSequence += 1;
    const user = await prisma.user.create({
      data: {
        name: 'Default Status User',
        email: `payment-default-${fixtureSequence}@example.com`,
        passwordHash: 'hashed-password',
      },
    });
    const idempotencyKey = `payment-default-${fixtureSequence}`;
    await prisma.$executeRaw`
      INSERT INTO payments (user_id, amount, plan_tier, idempotency_key, updated_at)
      VALUES (${user.id}, ${999}, ${'basico'}, ${idempotencyKey}, ${new Date()})
    `;

    await expect(
      prisma.payment.findUnique({ where: { idempotencyKey } })
    ).resolves.toMatchObject({ status: 'created' });
  });
});
