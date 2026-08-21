import { jest } from '@jest/globals';
import { setupTestDb } from './helpers/db.setup.js';
import prisma from '../utils/prismaClient.js';

const retrievePaymentIntent = jest.fn();
const listPaymentIntents = jest.fn(async () => []);

// No network: paymentReconcileService only ever talks to Stripe through
// services/stripeClient.js, so mocking that one module fully isolates it.
jest.unstable_mockModule('../services/stripeClient.js', () => ({
  default: { retrievePaymentIntent, listPaymentIntents },
  retrievePaymentIntent,
  listPaymentIntents,
}));

const { reconcilePayments, mapStripeStatusToLocal, buildDiff, parseSince, summarize } = await import(
  '../services/paymentReconcileService.js'
);
const { markPaymentCompleted } = await import('../services/paymentService.js');

setupTestDb();

describe('paymentReconcileService', () => {
  let userId;

  beforeEach(async () => {
    retrievePaymentIntent.mockReset();
    listPaymentIntents.mockReset().mockResolvedValue([]);

    const user = await prisma.user.create({
      data: {
        email: `reconcile-${Date.now()}-${Math.random().toString(36).slice(2)}@example.com`,
        passwordHash: 'hashed',
        name: 'Reconcile Test User',
      },
    });
    userId = user.id;
  });

  const createPayment = async (overrides = {}) =>
    prisma.payment.create({
      data: {
        userId,
        amount: 999,
        currency: 'usd',
        planTier: 'basico',
        status: 'pending',
        provider: 'stripe',
        idempotencyKey: `reconcile-${Date.now()}-${Math.random().toString(36).slice(2)}`,
        stripePaymentIntentId: `pi_${Date.now()}_${Math.random().toString(36).slice(2)}`,
        ...overrides,
      },
    });

  describe('pure helpers', () => {
    test('mapStripeStatusToLocal only maps the four documented Stripe statuses', () => {
      expect(mapStripeStatusToLocal('succeeded')).toBe('completed');
      expect(mapStripeStatusToLocal('canceled')).toBe('canceled');
      expect(mapStripeStatusToLocal('requires_payment_method')).toBe('pending');
      expect(mapStripeStatusToLocal('requires_action')).toBe('pending');
      expect(mapStripeStatusToLocal('processing')).toBeNull();
      expect(mapStripeStatusToLocal('requires_capture')).toBeNull();
    });

    test('buildDiff flags a mismatch only when the mapped status differs', () => {
      const mismatched = buildDiff({
        payment: { id: 1, status: 'pending' },
        stripePaymentIntent: { id: 'pi_1', status: 'succeeded' },
      });
      expect(mismatched.mismatch).toBe(true);
      expect(mismatched.mappedLocalStatus).toBe('completed');

      const matched = buildDiff({
        payment: { id: 1, status: 'completed' },
        stripePaymentIntent: { id: 'pi_1', status: 'succeeded' },
      });
      expect(matched.mismatch).toBe(false);

      const inconclusive = buildDiff({
        payment: { id: 1, status: 'pending' },
        stripePaymentIntent: { id: 'pi_1', status: 'processing' },
      });
      expect(inconclusive.mismatch).toBe(false);
      expect(inconclusive.mappedLocalStatus).toBeNull();
    });

    test('parseSince accepts h/d/m suffixes and rejects invalid input', () => {
      const now = Date.now();
      expect(parseSince('24h').getTime()).toBeLessThan(now);
      expect(parseSince('7d').getTime()).toBeLessThan(now);
      expect(() => parseSince('nonsense')).toThrow();
      expect(() => parseSince('24')).toThrow();
    });

    test('summarize counts checked/mismatched/repaired/skipped/errors', () => {
      const summary = summarize([
        { mismatch: false, action: 'none' },
        { mismatch: true, action: 'repaired' },
        { mismatch: false, action: 'skipped' },
        { mismatch: true, action: 'error' },
      ]);
      expect(summary).toEqual({ checked: 4, mismatched: 2, repaired: 1, skipped: 1, errors: 1 });
    });
  });

  test('dry-run never modifies the database', async () => {
    const payment = await createPayment();
    retrievePaymentIntent.mockResolvedValue({ id: payment.stripePaymentIntentId, status: 'succeeded' });

    const { summary } = await reconcilePayments({ paymentId: payment.id, apply: false });

    expect(summary).toEqual({ checked: 1, mismatched: 1, repaired: 0, skipped: 0, errors: 0 });

    const unchanged = await prisma.payment.findUnique({ where: { id: payment.id } });
    expect(unchanged.status).toBe('pending');

    const user = await prisma.user.findUnique({ where: { id: userId } });
    expect(user.planTier).toBeNull();

    const events = await prisma.paymentEvent.findMany({ where: { paymentId: payment.id } });
    expect(events).toHaveLength(0);
  });

  test('apply repairs a succeeded payment and activates the plan', async () => {
    const payment = await createPayment();
    retrievePaymentIntent.mockResolvedValue({ id: payment.stripePaymentIntentId, status: 'succeeded' });

    const { summary } = await reconcilePayments({ paymentId: payment.id, apply: true });

    expect(summary.repaired).toBe(1);
    expect(summary.errors).toBe(0);

    const updated = await prisma.payment.findUnique({ where: { id: payment.id } });
    expect(updated.status).toBe('completed');

    const user = await prisma.user.findUnique({ where: { id: userId } });
    expect(user.planTier).toBe('basico');
    expect(user.role).toBe('premium');

    const events = await prisma.paymentEvent.findMany({ where: { paymentId: payment.id } });
    const types = events.map((e) => e.type).sort();
    expect(types).toEqual(['payment.completed', 'reconcile.mismatch', 'reconcile.repaired']);
  });

  test('apply repairs a canceled PaymentIntent to canceled without touching entitlements', async () => {
    const payment = await createPayment();
    retrievePaymentIntent.mockResolvedValue({ id: payment.stripePaymentIntentId, status: 'canceled' });

    const { summary } = await reconcilePayments({ paymentId: payment.id, apply: true });

    expect(summary.repaired).toBe(1);

    const updated = await prisma.payment.findUnique({ where: { id: payment.id } });
    expect(updated.status).toBe('canceled');

    const user = await prisma.user.findUnique({ where: { id: userId } });
    expect(user.planTier).toBeNull();
    expect(user.role).toBe('student');
  });

  test('apply revokes a previously-granted entitlement when a completed payment turns out canceled on Stripe', async () => {
    const payment = await createPayment();
    await markPaymentCompleted({ paymentId: payment.id, subscriptionExternalId: payment.stripePaymentIntentId });

    const grantedUser = await prisma.user.findUnique({ where: { id: userId } });
    expect(grantedUser.planTier).toBe('basico');
    expect(grantedUser.role).toBe('premium');

    retrievePaymentIntent.mockResolvedValue({ id: payment.stripePaymentIntentId, status: 'canceled' });

    const { summary } = await reconcilePayments({ paymentId: payment.id, apply: true });

    expect(summary.repaired).toBe(1);

    const updatedPayment = await prisma.payment.findUnique({ where: { id: payment.id } });
    expect(updatedPayment.status).toBe('canceled');

    const subscription = await prisma.subscription.findUnique({
      where: { provider_externalId: { provider: 'stripe', externalId: payment.stripePaymentIntentId } },
    });
    expect(subscription.status).toBe('canceled');

    const downgradedUser = await prisma.user.findUnique({ where: { id: userId } });
    expect(downgradedUser.planTier).toBeNull();
    expect(downgradedUser.role).toBe('student');

    const repairedEvent = await prisma.paymentEvent.findFirst({
      where: { paymentId: payment.id, type: 'reconcile.repaired' },
    });
    expect(JSON.parse(repairedEvent.payload)).toMatchObject({ entitlementRevoked: true });
  });

  test.each(['requires_payment_method', 'requires_action'])(
    'apply normalizes "%s" to pending and never grants a plan',
    async (stripeStatus) => {
      const payment = await createPayment({ status: 'failed' });
      retrievePaymentIntent.mockResolvedValue({ id: payment.stripePaymentIntentId, status: stripeStatus });

      const { summary } = await reconcilePayments({ paymentId: payment.id, apply: true });

      expect(summary.repaired).toBe(1);

      const updated = await prisma.payment.findUnique({ where: { id: payment.id } });
      expect(updated.status).toBe('pending');

      const user = await prisma.user.findUnique({ where: { id: userId } });
      expect(user.planTier).toBeNull();
      expect(user.role).not.toBe('premium');
    }
  );

  test('an inconclusive Stripe status (e.g. processing) is neither a mismatch nor repaired', async () => {
    const payment = await createPayment();
    retrievePaymentIntent.mockResolvedValue({ id: payment.stripePaymentIntentId, status: 'processing' });

    const { summary } = await reconcilePayments({ paymentId: payment.id, apply: true });

    expect(summary).toEqual({ checked: 1, mismatched: 0, repaired: 0, skipped: 0, errors: 0 });

    const unchanged = await prisma.payment.findUnique({ where: { id: payment.id } });
    expect(unchanged.status).toBe('pending');
  });

  test('every repair writes a reconcile.repaired PaymentEvent', async () => {
    const payment = await createPayment();
    retrievePaymentIntent.mockResolvedValue({ id: payment.stripePaymentIntentId, status: 'canceled' });

    await reconcilePayments({ paymentId: payment.id, apply: true });

    const repairedEvents = await prisma.paymentEvent.findMany({
      where: { paymentId: payment.id, type: 'reconcile.repaired' },
    });
    expect(repairedEvents).toHaveLength(1);
    const payload = JSON.parse(repairedEvents[0].payload);
    expect(payload).toMatchObject({ from: 'pending', to: 'canceled', stripeStatus: 'canceled' });
  });

  test('a per-candidate Stripe error is recorded and yields a non-zero-signaling summary', async () => {
    const payment = await createPayment();
    retrievePaymentIntent.mockRejectedValue(new Error('stripe unavailable'));

    const { summary, results } = await reconcilePayments({ paymentId: payment.id, apply: true });

    expect(summary.errors).toBe(1);
    expect(results[0].action).toBe('error');

    const errorEvents = await prisma.paymentEvent.findMany({
      where: { paymentId: payment.id, type: 'reconcile.error' },
    });
    expect(errorEvents).toHaveLength(1);
  });

  test('re-running apply on an already-repaired payment is a no-op the second time', async () => {
    const payment = await createPayment();
    retrievePaymentIntent.mockResolvedValue({ id: payment.stripePaymentIntentId, status: 'canceled' });

    const first = await reconcilePayments({ paymentId: payment.id, apply: true });
    expect(first.summary.repaired).toBe(1);

    const second = await reconcilePayments({ paymentId: payment.id, apply: true });
    expect(second.summary).toEqual({ checked: 1, mismatched: 0, repaired: 0, skipped: 0, errors: 0 });
  });

  test('--since scopes DB candidates to payments created in the window', async () => {
    const inWindow = await createPayment();
    const outOfWindow = await createPayment({
      createdAt: new Date(Date.now() - 30 * 24 * 60 * 60 * 1000),
    });
    retrievePaymentIntent.mockResolvedValue({ id: 'pi_unused', status: 'canceled' });

    const since = parseSince('24h');
    const { results } = await reconcilePayments({ since, limit: 50, apply: false });

    const ids = results.map((r) => r.paymentId);
    expect(ids).toContain(inWindow.id);
    expect(ids).not.toContain(outOfWindow.id);
  });
});
