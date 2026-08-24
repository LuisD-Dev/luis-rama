import { readFileSync } from 'fs';
import { jest } from '@jest/globals';
import { setupTestDb } from './helpers/db.setup.js';
import prisma from '../utils/prismaClient.js';

const retrievePaymentIntent = jest.fn();
const listPaymentIntents = jest.fn(async () => []);

// No network: reconciliation talks to Stripe only through stripeClient.js.
jest.unstable_mockModule('../services/stripeClient.js', () => ({
  default: { retrievePaymentIntent, listPaymentIntents },
  retrievePaymentIntent,
  listPaymentIntents,
}));

const {
  reconcilePayments,
  mapStripeStatusToLocal,
  buildDiff,
  parseSince,
  summarize,
  planReconciliationTransitions,
} = await import('../services/paymentReconcileService.js');
const { markPaymentCompleted } = await import('../services/paymentService.js');
const { PAYMENT_STATUSES } = await import('../services/paymentStateMachine.js');

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
        status: PAYMENT_STATUSES.PENDING,
        provider: 'stripe',
        idempotencyKey: `reconcile-${Date.now()}-${Math.random().toString(36).slice(2)}`,
        stripePaymentIntentId: `pi_${Date.now()}_${Math.random().toString(36).slice(2)}`,
        ...overrides,
      },
    });

  const mockStripeStatus = (payment, status) =>
    retrievePaymentIntent.mockResolvedValue({
      id: payment.stripePaymentIntentId,
      status,
    });

  describe('pure helpers', () => {
    test('maps Stripe statuses to canonical local statuses, never completed', () => {
      expect(mapStripeStatusToLocal('succeeded')).toBe(PAYMENT_STATUSES.SUCCEEDED);
      expect(mapStripeStatusToLocal('succeeded')).not.toBe('completed');
      expect(mapStripeStatusToLocal('canceled')).toBe(PAYMENT_STATUSES.CANCELED);
      expect(mapStripeStatusToLocal('requires_payment_method')).toBe(PAYMENT_STATUSES.PENDING);
      expect(mapStripeStatusToLocal('requires_action')).toBe(PAYMENT_STATUSES.PENDING);
      expect(mapStripeStatusToLocal('processing')).toBeNull();
      expect(mapStripeStatusToLocal('requires_capture')).toBeNull();
    });

    test('buildDiff uses canonical succeeded and remains rollout-compatible with legacy success rows', () => {
      const mismatched = buildDiff({
        payment: { id: 1, status: PAYMENT_STATUSES.PENDING },
        stripePaymentIntent: { id: 'pi_1', status: 'succeeded' },
      });
      expect(mismatched).toMatchObject({
        mismatch: true,
        mappedLocalStatus: PAYMENT_STATUSES.SUCCEEDED,
      });

      for (const localStatus of [PAYMENT_STATUSES.SUCCEEDED, 'completed', 'processed']) {
        const matched = buildDiff({
          payment: { id: 1, status: localStatus },
          stripePaymentIntent: { id: 'pi_1', status: 'succeeded' },
        });
        expect(matched.mismatch).toBe(false);
        expect(matched.mappedLocalStatus).toBe(PAYMENT_STATUSES.SUCCEEDED);
      }

      const inconclusive = buildDiff({
        payment: { id: 1, status: PAYMENT_STATUSES.PENDING },
        stripePaymentIntent: { id: 'pi_1', status: 'processing' },
      });
      expect(inconclusive.mismatch).toBe(false);
      expect(inconclusive.mappedLocalStatus).toBeNull();
    });

    test('plans only legal state-machine edges for failed -> succeeded', () => {
      expect(
        planReconciliationTransitions(
          PAYMENT_STATUSES.FAILED,
          PAYMENT_STATUSES.SUCCEEDED
        )
      ).toEqual([
        PAYMENT_STATUSES.PENDING,
        PAYMENT_STATUSES.PROCESSING,
        PAYMENT_STATUSES.SUCCEEDED,
      ]);
    });

    test('plans processing -> failed -> pending instead of an illegal direct edge', () => {
      expect(
        planReconciliationTransitions(
          PAYMENT_STATUSES.PROCESSING,
          PAYMENT_STATUSES.PENDING
        )
      ).toEqual([PAYMENT_STATUSES.FAILED, PAYMENT_STATUSES.PENDING]);
    });

    test('rejects contradictory targets for succeeded and canceled terminal states', () => {
      expect(() =>
        planReconciliationTransitions(
          PAYMENT_STATUSES.SUCCEEDED,
          PAYMENT_STATUSES.CANCELED
        )
      ).toThrow(/terminal payment state/);
      expect(() =>
        planReconciliationTransitions(
          PAYMENT_STATUSES.CANCELED,
          PAYMENT_STATUSES.SUCCEEDED
        )
      ).toThrow(/terminal payment state/);
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
      expect(summary).toEqual({
        checked: 4,
        mismatched: 2,
        repaired: 1,
        skipped: 1,
        errors: 1,
      });
    });

    test('contains no direct Payment mutation and delegates status writes to the state machine', () => {
      const source = readFileSync(
        new URL('../services/paymentReconcileService.js', import.meta.url),
        'utf8'
      );
      expect(source).not.toMatch(/\.payment\.(?:create|update|updateMany)\s*\(/);
      expect(source).toContain('applyTransition(');
      expect(source).toContain('markPaymentCompleted(');
    });
  });

  test('dry-run reports a repair but performs no database writes', async () => {
    const payment = await createPayment();
    mockStripeStatus(payment, 'succeeded');

    const { summary } = await reconcilePayments({
      paymentId: payment.id,
      apply: false,
    });

    expect(summary).toEqual({
      checked: 1,
      mismatched: 1,
      repaired: 0,
      skipped: 0,
      errors: 0,
    });
    expect(
      (await prisma.payment.findUnique({ where: { id: payment.id } })).status
    ).toBe(PAYMENT_STATUSES.PENDING);
    expect((await prisma.user.findUnique({ where: { id: userId } })).planTier).toBeNull();
    expect(
      await prisma.paymentEvent.findMany({ where: { paymentId: payment.id } })
    ).toHaveLength(0);
  });

  test('pending -> processing -> succeeded activates the plan through canonical completion', async () => {
    const payment = await createPayment();
    mockStripeStatus(payment, 'succeeded');

    const { summary } = await reconcilePayments({
      paymentId: payment.id,
      apply: true,
    });

    expect(summary).toMatchObject({ repaired: 1, errors: 0 });
    expect(
      (await prisma.payment.findUnique({ where: { id: payment.id } })).status
    ).toBe(PAYMENT_STATUSES.SUCCEEDED);

    const user = await prisma.user.findUnique({ where: { id: userId } });
    expect(user).toMatchObject({ planTier: 'basico', role: 'premium' });

    const events = await prisma.paymentEvent.findMany({
      where: { paymentId: payment.id },
    });
    expect(events.map((event) => event.type).sort()).toEqual([
      'payment.completed',
      'reconcile.mismatch',
      'reconcile.repaired',
    ]);
    const repaired = events.find((event) => event.type === 'reconcile.repaired');
    expect(JSON.parse(repaired.payload)).toMatchObject({
      from: PAYMENT_STATUSES.PENDING,
      to: PAYMENT_STATUSES.SUCCEEDED,
      stripeStatus: 'succeeded',
    });
  });

  test('failed -> pending -> processing -> succeeded uses trusted reconciliation and grants once', async () => {
    const payment = await createPayment({ status: PAYMENT_STATUSES.FAILED });
    mockStripeStatus(payment, 'succeeded');

    const first = await reconcilePayments({
      paymentId: payment.id,
      apply: true,
      runId: 'failed-success-first',
    });
    const second = await reconcilePayments({
      paymentId: payment.id,
      apply: true,
      runId: 'failed-success-second',
    });

    expect(first.summary).toMatchObject({ repaired: 1, errors: 0 });
    expect(second.summary).toMatchObject({ repaired: 0, errors: 0 });
    expect(
      (await prisma.payment.findUnique({ where: { id: payment.id } })).status
    ).toBe(PAYMENT_STATUSES.SUCCEEDED);
    expect(await prisma.subscription.count({ where: { userId } })).toBe(1);
    expect(
      await prisma.paymentEvent.count({
        where: { paymentId: payment.id, type: 'payment.completed' },
      })
    ).toBe(1);
  });

  test('processing -> failed -> pending uses only legal reconciliation edges', async () => {
    const payment = await createPayment({ status: PAYMENT_STATUSES.PROCESSING });
    mockStripeStatus(payment, 'requires_action');

    const { summary } = await reconcilePayments({
      paymentId: payment.id,
      apply: true,
    });

    expect(summary).toMatchObject({ repaired: 1, errors: 0 });
    expect(
      (await prisma.payment.findUnique({ where: { id: payment.id } })).status
    ).toBe(PAYMENT_STATUSES.PENDING);
    const user = await prisma.user.findUnique({ where: { id: userId } });
    expect(user.planTier).toBeNull();
    expect(user.role).not.toBe('premium');
  });

  test('pending -> canceled does not touch entitlements', async () => {
    const payment = await createPayment();
    mockStripeStatus(payment, 'canceled');

    const { summary } = await reconcilePayments({
      paymentId: payment.id,
      apply: true,
    });

    expect(summary).toMatchObject({ repaired: 1, errors: 0 });
    expect(
      (await prisma.payment.findUnique({ where: { id: payment.id } })).status
    ).toBe(PAYMENT_STATUSES.CANCELED);
    expect(await prisma.user.findUnique({ where: { id: userId } })).toMatchObject({
      planTier: null,
      role: 'student',
    });
  });

  test.each(['requires_payment_method', 'requires_action'])(
    'failed -> pending for Stripe "%s" never grants a plan',
    async (stripeStatus) => {
      const payment = await createPayment({ status: PAYMENT_STATUSES.FAILED });
      mockStripeStatus(payment, stripeStatus);

      const { summary } = await reconcilePayments({
        paymentId: payment.id,
        apply: true,
      });

      expect(summary).toMatchObject({ repaired: 1, errors: 0 });
      expect(
        (await prisma.payment.findUnique({ where: { id: payment.id } })).status
      ).toBe(PAYMENT_STATUSES.PENDING);
      const user = await prisma.user.findUnique({ where: { id: userId } });
      expect(user.planTier).toBeNull();
      expect(user.role).not.toBe('premium');
    }
  );

  test('succeeded remains terminal when Stripe contradicts it with canceled', async () => {
    const payment = await createPayment();
    await markPaymentCompleted({
      paymentId: payment.id,
      subscriptionExternalId: payment.stripePaymentIntentId,
    });
    mockStripeStatus(payment, 'canceled');

    const { summary, results } = await reconcilePayments({
      paymentId: payment.id,
      apply: true,
    });

    expect(summary).toMatchObject({ mismatched: 1, repaired: 0, errors: 1 });
    expect(results[0]).toMatchObject({ action: 'error' });
    expect(results[0].error).toMatch(/terminal payment state/);
    expect(
      (await prisma.payment.findUnique({ where: { id: payment.id } })).status
    ).toBe(PAYMENT_STATUSES.SUCCEEDED);
    expect(await prisma.user.findUnique({ where: { id: userId } })).toMatchObject({
      planTier: 'basico',
      role: 'premium',
    });
    expect(
      await prisma.subscription.findUnique({
        where: {
          provider_externalId: {
            provider: 'stripe',
            externalId: payment.stripePaymentIntentId,
          },
        },
      })
    ).toMatchObject({ status: 'active' });
    expect(
      await prisma.paymentEvent.count({
        where: { paymentId: payment.id, type: 'reconcile.repaired' },
      })
    ).toBe(0);
    expect(
      await prisma.paymentEvent.count({
        where: { paymentId: payment.id, type: 'reconcile.error' },
      })
    ).toBe(1);
  });

  test('canceled remains terminal when Stripe contradicts it with succeeded', async () => {
    const payment = await createPayment({ status: PAYMENT_STATUSES.CANCELED });
    mockStripeStatus(payment, 'succeeded');

    const { summary, results } = await reconcilePayments({
      paymentId: payment.id,
      apply: true,
    });

    expect(summary).toMatchObject({ mismatched: 1, repaired: 0, errors: 1 });
    expect(results[0]).toMatchObject({ action: 'error' });
    expect(results[0].error).toMatch(/terminal payment state/);
    expect(
      (await prisma.payment.findUnique({ where: { id: payment.id } })).status
    ).toBe(PAYMENT_STATUSES.CANCELED);
    expect(await prisma.user.findUnique({ where: { id: userId } })).toMatchObject({
      planTier: null,
      role: 'student',
    });
    expect(await prisma.subscription.count({ where: { userId } })).toBe(0);
    expect(
      await prisma.paymentEvent.count({
        where: { paymentId: payment.id, type: 'reconcile.repaired' },
      })
    ).toBe(0);
  });

  test('an inconclusive Stripe status is checked but never repaired', async () => {
    const payment = await createPayment();
    mockStripeStatus(payment, 'processing');

    const { summary } = await reconcilePayments({
      paymentId: payment.id,
      apply: true,
    });

    expect(summary).toEqual({
      checked: 1,
      mismatched: 0,
      repaired: 0,
      skipped: 0,
      errors: 0,
    });
    expect(
      (await prisma.payment.findUnique({ where: { id: payment.id } })).status
    ).toBe(PAYMENT_STATUSES.PENDING);
    expect(
      await prisma.paymentEvent.count({
        where: { paymentId: payment.id, type: 'reconcile.checked' },
      })
    ).toBe(1);
  });

  test('every successful repair writes reconcile.repaired', async () => {
    const payment = await createPayment();
    mockStripeStatus(payment, 'canceled');

    await reconcilePayments({ paymentId: payment.id, apply: true });

    const repairedEvents = await prisma.paymentEvent.findMany({
      where: { paymentId: payment.id, type: 'reconcile.repaired' },
    });
    expect(repairedEvents).toHaveLength(1);
    expect(JSON.parse(repairedEvents[0].payload)).toMatchObject({
      from: PAYMENT_STATUSES.PENDING,
      to: PAYMENT_STATUSES.CANCELED,
      stripeStatus: 'canceled',
    });
  });

  test('a Stripe lookup error is audited and yields a non-zero summary', async () => {
    const payment = await createPayment();
    retrievePaymentIntent.mockRejectedValue(new Error('stripe unavailable'));

    const { summary, results } = await reconcilePayments({
      paymentId: payment.id,
      apply: true,
    });

    expect(summary.errors).toBe(1);
    expect(results[0].action).toBe('error');
    expect(
      await prisma.paymentEvent.count({
        where: { paymentId: payment.id, type: 'reconcile.error' },
      })
    ).toBe(1);
  });

  test('re-running apply on an already-repaired payment is a no-op', async () => {
    const payment = await createPayment();
    mockStripeStatus(payment, 'canceled');

    const first = await reconcilePayments({ paymentId: payment.id, apply: true });
    const second = await reconcilePayments({ paymentId: payment.id, apply: true });

    expect(first.summary.repaired).toBe(1);
    expect(second.summary).toEqual({
      checked: 1,
      mismatched: 0,
      repaired: 0,
      skipped: 0,
      errors: 0,
    });
  });

  test('--since scopes DB candidates to payments created in the window', async () => {
    const inWindow = await createPayment();
    const outOfWindow = await createPayment({
      createdAt: new Date(Date.now() - 30 * 24 * 60 * 60 * 1000),
    });
    retrievePaymentIntent.mockResolvedValue({ id: 'pi_unused', status: 'canceled' });

    const { results } = await reconcilePayments({
      since: parseSince('24h'),
      limit: 50,
      apply: false,
    });

    const ids = results.map((result) => result.paymentId);
    expect(ids).toContain(inWindow.id);
    expect(ids).not.toContain(outOfWindow.id);
  });
});
