import { parseArgs, validateEnvironment, toTableRow, computeExitCode } from '../scripts/reconcilePayments.js';

describe('reconcilePayments CLI', () => {
  describe('parseArgs', () => {
    test('defaults to dry-run (apply=false) when --apply is absent', () => {
      const args = parseArgs(['--since=24h']);
      expect(args.apply).toBe(false);
      expect(args.since).toBe('24h');
    });

    test('--apply flips apply to true', () => {
      const args = parseArgs(['--since=7d', '--apply']);
      expect(args.apply).toBe(true);
    });

    test('parses --limit and --payment-id as numbers', () => {
      const args = parseArgs(['--since=7d', '--limit=100']);
      expect(args.limit).toBe(100);

      const single = parseArgs(['--payment-id=123', '--apply']);
      expect(single.paymentId).toBe(123);
    });

    test('requires either --since or --payment-id', () => {
      expect(() => parseArgs(['--apply'])).toThrow(/--since|--payment-id/);
    });

    test('rejects an unknown flag', () => {
      expect(() => parseArgs(['--since=24h', '--bogus=1'])).toThrow(/Unknown flag/);
    });

    test('rejects a non-positive --limit', () => {
      expect(() => parseArgs(['--since=24h', '--limit=0'])).toThrow(/--limit/);
    });
  });

  describe('validateEnvironment', () => {
    test('throws when STRIPE_SECRET_KEY is missing', () => {
      expect(() => validateEnvironment({ apply: false }, {})).toThrow(/STRIPE_SECRET_KEY/);
    });

    test('allows dry-run in production without RECONCILE_CONFIRM', () => {
      expect(() =>
        validateEnvironment({ apply: false }, { STRIPE_SECRET_KEY: 'sk_test', NODE_ENV: 'production' })
      ).not.toThrow();
    });

    test('refuses --apply in production without RECONCILE_CONFIRM=YES', () => {
      expect(() =>
        validateEnvironment({ apply: true }, { STRIPE_SECRET_KEY: 'sk_test', NODE_ENV: 'production' })
      ).toThrow(/RECONCILE_CONFIRM/);
    });

    test('allows --apply in production when RECONCILE_CONFIRM=YES', () => {
      expect(() =>
        validateEnvironment(
          { apply: true },
          { STRIPE_SECRET_KEY: 'sk_test', NODE_ENV: 'production', RECONCILE_CONFIRM: 'YES' }
        )
      ).not.toThrow();
    });

    test('allows --apply outside production without RECONCILE_CONFIRM', () => {
      expect(() =>
        validateEnvironment({ apply: true }, { STRIPE_SECRET_KEY: 'sk_test', NODE_ENV: 'development' })
      ).not.toThrow();
    });
  });

  describe('toTableRow', () => {
    test('renders missing fields as an em dash', () => {
      const row = toTableRow({
        paymentId: null,
        stripePaymentIntentId: 'pi_orphan',
        localStatus: null,
        stripeStatus: 'succeeded',
        mismatch: false,
        action: 'skipped',
      });
      expect(row.paymentId).toBe('—');
      expect(row.localStatus).toBe('—');
      expect(row.mismatch).toBe('no');
    });
  });

  describe('computeExitCode', () => {
    test('is 0 when there are no errors, even with mismatches/repairs', () => {
      expect(computeExitCode({ checked: 10, mismatched: 3, repaired: 3, skipped: 0, errors: 0 })).toBe(0);
    });

    test('is non-zero when there are partial errors', () => {
      expect(computeExitCode({ checked: 10, mismatched: 3, repaired: 2, skipped: 0, errors: 1 })).toBe(1);
    });
  });
});
