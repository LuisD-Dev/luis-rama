import { pathToFileURL } from 'url';
import prisma from '../utils/prismaClient.js';

export const CANONICAL_PAYMENT_STATUSES = Object.freeze([
  'created',
  'pending',
  'processing',
  'succeeded',
  'failed',
  'canceled',
]);

export const LEGACY_PAYMENT_STATUSES = Object.freeze([
  'completed',
  'processed',
]);

const canonicalStatusSet = new Set(CANONICAL_PAYMENT_STATUSES);

const summarizeStatuses = async (db) => {
  const groups = await db.payment.groupBy({
    by: ['status'],
    _count: { _all: true },
    orderBy: { status: 'asc' },
  });

  const countFor = (status) =>
    groups.find((group) => group.status === status)?._count?._all || 0;
  const unknownStatuses = groups
    .filter((group) => !canonicalStatusSet.has(group.status) &&
      !LEGACY_PAYMENT_STATUSES.includes(group.status))
    .map((group) => ({
      status: group.status,
      count: group._count._all,
    }));

  return {
    completed: countFor('completed'),
    processed: countFor('processed'),
    otherNoncanonical: unknownStatuses.reduce(
      (total, entry) => total + entry.count,
      0
    ),
    unknownStatuses,
  };
};

export async function migrateLegacyPaymentStatuses(db, { apply } = {}) {
  if (!db?.payment || typeof db.payment.groupBy !== 'function') {
    throw new TypeError('A Prisma client with Payment access is required');
  }
  if (typeof apply !== 'boolean') {
    throw new TypeError('The apply option must be explicitly true or false');
  }

  if (!apply) {
    const before = await summarizeStatuses(db);
    return {
      mode: 'dry-run',
      before,
      after: before,
      updatedCount: 0,
      legacyCleared: before.completed === 0 && before.processed === 0,
      hasUnknownStatuses: before.otherNoncanonical > 0,
      success: true,
    };
  }

  return db.$transaction(async (tx) => {
    const before = await summarizeStatuses(tx);
    const update = await tx.payment.updateMany({
      where: {
        status: { in: LEGACY_PAYMENT_STATUSES },
      },
      data: { status: 'succeeded' },
    });
    const after = await summarizeStatuses(tx);
    const legacyCleared = after.completed === 0 && after.processed === 0;
    const hasUnknownStatuses = after.otherNoncanonical > 0;

    return {
      mode: 'apply',
      before,
      after,
      updatedCount: update.count,
      legacyCleared,
      hasUnknownStatuses,
      success: legacyCleared && !hasUnknownStatuses,
    };
  });
}

const printSummary = (write, label, summary) => {
  write(`${label}:`);
  write(`  completed: ${summary.completed}`);
  write(`  processed: ${summary.processed}`);
  write(`  other noncanonical: ${summary.otherNoncanonical}`);
  for (const entry of summary.unknownStatuses) {
    write(`  unknown ${entry.status}: ${entry.count}`);
  }
};

const printUsage = (write) => {
  write('Usage: node scripts/migratePaymentStatuses.js --dry-run|--apply');
};

export async function runPaymentStatusMigrationCli(
  args,
  { db = prisma, stdout = console.log, stderr = console.error } = {}
) {
  const dryRun = args.includes('--dry-run');
  const apply = args.includes('--apply');
  const hasUnknownArguments = args.some(
    (arg) => arg !== '--dry-run' && arg !== '--apply'
  );

  if (dryRun === apply || hasUnknownArguments) {
    printUsage(stderr);
    return 2;
  }

  const result = await migrateLegacyPaymentStatuses(db, { apply });
  stdout(`Payment status migration ${result.mode}`);
  printSummary(stdout, 'Before', result.before);
  if (apply) {
    stdout(`Updated legacy rows: ${result.updatedCount}`);
    printSummary(stdout, 'After', result.after);
    if (!result.legacyCleared) {
      stderr('Legacy payment statuses remain after migration.');
    }
    if (result.hasUnknownStatuses) {
      stderr('Unknown noncanonical payment statuses remain unchanged.');
    }
    return result.success ? 0 : 1;
  }

  stdout('Dry run only; no rows were changed.');
  if (result.hasUnknownStatuses) {
    stdout('Unknown noncanonical payment statuses would remain unchanged.');
  }
  return 0;
}

const isEntrypoint = process.argv[1] &&
  import.meta.url === pathToFileURL(process.argv[1]).href;

if (isEntrypoint) {
  try {
    process.exitCode = await runPaymentStatusMigrationCli(process.argv.slice(2));
  } catch (_error) {
    console.error('Payment status migration failed. No row details were printed.');
    process.exitCode = 1;
  } finally {
    await prisma.$disconnect();
  }
}
