import { pathToFileURL } from 'url';
import prisma from '../utils/prismaClient.js';
import { reconcilePayments, parseSince } from '../services/paymentReconcileService.js';

const DEFAULT_LIMIT = 50;
const FLAG_PATTERN = /^--([a-z-]+)=(.*)$/;

/** Parse CLI argv into a plain options object. Unknown/malformed flags throw. */
export function parseArgs(argv) {
  const args = { apply: false, since: null, limit: null, paymentId: null };

  for (const raw of argv) {
    if (raw === '--dry-run') continue; // dry-run is the default; the flag is accepted for explicitness only
    if (raw === '--apply') {
      args.apply = true;
      continue;
    }

    const match = FLAG_PATTERN.exec(raw);
    if (!match) {
      throw new Error(`Unrecognized argument: ${raw}`);
    }
    const [, key, value] = match;

    if (key === 'since') args.since = value;
    else if (key === 'limit') args.limit = Number(value);
    else if (key === 'payment-id') args.paymentId = Number(value);
    else throw new Error(`Unknown flag --${key}`);
  }

  if (!args.paymentId && !args.since) {
    throw new Error('Provide --since=<24h|7d|...> or --payment-id=<id>.');
  }
  if (args.limit != null && (!Number.isFinite(args.limit) || args.limit <= 0)) {
    throw new Error('--limit must be a positive number.');
  }
  if (args.paymentId != null && (!Number.isFinite(args.paymentId) || args.paymentId <= 0)) {
    throw new Error('--payment-id must be a positive number.');
  }

  return args;
}

/**
 * Refuse to run when Stripe isn't reachable, and refuse --apply in production
 * unless an operator has explicitly confirmed via RECONCILE_CONFIRM=YES.
 */
export function validateEnvironment(args, env = process.env) {
  if (!env.STRIPE_SECRET_KEY) {
    throw new Error('STRIPE_SECRET_KEY is required to contact Stripe for reconciliation.');
  }
  if (args.apply && env.NODE_ENV === 'production' && env.RECONCILE_CONFIRM !== 'YES') {
    throw new Error(
      'Refusing to run --apply in production without RECONCILE_CONFIRM=YES. ' +
        'Set RECONCILE_CONFIRM=YES to confirm you intend to modify production payment data.'
    );
  }
}

export function toTableRow(result) {
  return {
    paymentId: result.paymentId ?? '—',
    stripePaymentIntentId: result.stripePaymentIntentId ?? '—',
    localStatus: result.localStatus ?? '—',
    stripeStatus: result.stripeStatus ?? '—',
    mismatch: result.mismatch ? 'yes' : 'no',
    action: result.action,
  };
}

/** Non-zero only when the run produced partial failures — mismatches/repairs alone are success. */
export function computeExitCode(summary) {
  return summary.errors > 0 ? 1 : 0;
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  validateEnvironment(args);

  const since = args.paymentId ? null : parseSince(args.since);
  const limit = args.limit ?? DEFAULT_LIMIT;

  console.log(`Mode: ${args.apply ? 'APPLY (writes changes)' : 'DRY-RUN (read-only, default)'}`);
  console.log(
    args.paymentId
      ? `Target: payment #${args.paymentId}`
      : `Target: payments since ${since.toISOString()} (limit ${limit})`
  );

  const { runId, results, summary } = await reconcilePayments({
    since,
    limit,
    paymentId: args.paymentId,
    apply: args.apply,
  });

  console.log(`Run ID: ${runId}\n`);

  if (results.length > 0) {
    console.table(results.map(toTableRow));
  } else {
    console.log('No candidates found.');
  }

  console.log('\nSummary:');
  console.log(JSON.stringify(summary, null, 2));

  process.exitCode = computeExitCode(summary);
}

const isMainModule = () => {
  try {
    return import.meta.url === pathToFileURL(process.argv[1]).href;
  } catch {
    return false;
  }
};

if (isMainModule()) {
  main()
    .catch((err) => {
      console.error('Reconciliation failed:', err.message);
      process.exitCode = 1;
    })
    .finally(async () => {
      // Swallow disconnect errors: if main() failed before Prisma ever
      // connected (e.g. missing DATABASE_URL/STRIPE_SECRET_KEY), accessing
      // $disconnect on the lazy client proxy throws synchronously — a second,
      // unrelated, more confusing error on top of the real one above.
      try {
        await prisma.$disconnect();
      } catch {
        // ignore — nothing was connected
      }
    });
}
