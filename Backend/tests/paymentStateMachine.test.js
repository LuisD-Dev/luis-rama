import { jest } from '@jest/globals';
import {
  PAYMENT_STATUSES,
  CANONICAL_PAYMENT_STATUSES,
  PaymentNotFoundError,
  PaymentTransitionError,
  applyTransition,
  assertTransition,
  createPaymentInPendingState,
  isCanonicalPaymentStatus,
} from '../services/paymentStateMachine.js';

const S = PAYMENT_STATUSES;

const adminReconcileMeta = {
  retryKind: 'reconcile',
  source: 'admin_reconcile',
  actorType: 'admin',
  reason: 'Operator verified Stripe state',
};

const systemReconcileMeta = {
  retryKind: 'reconcile',
  source: 'system_reconcile',
  actorType: 'system',
  reason: 'Automated reconciliation verified Stripe state',
};

const allowedEdges = [
  { from: S.CREATED, to: S.PENDING },
  { from: S.PENDING, to: S.PROCESSING },
  { from: S.PENDING, to: S.FAILED },
  { from: S.PENDING, to: S.CANCELED },
  { from: S.PROCESSING, to: S.SUCCEEDED },
  { from: S.PROCESSING, to: S.FAILED },
  { from: S.PROCESSING, to: S.CANCELED },
  { from: S.FAILED, to: S.PENDING, meta: adminReconcileMeta },
];

const allowedEdgeKeys = new Set(
  allowedEdges.map(({ from, to }) => `${from}->${to}`)
);
const illegalEdges = CANONICAL_PAYMENT_STATUSES.flatMap((from) =>
  CANONICAL_PAYMENT_STATUSES.filter(
    (to) => from !== to && !allowedEdgeKeys.has(`${from}->${to}`)
  ).map((to) => [from, to])
);

const createTx = ({ reads, count = 1 } = {}) => ({
  payment: {
    findUnique: jest.fn().mockImplementation(() => Promise.resolve(reads.shift())),
    updateMany: jest.fn().mockResolvedValue({ count }),
  },
});

describe('paymentStateMachine', () => {
  describe('constants', () => {
    test('exports exactly the canonical payment statuses as frozen values', () => {
      expect(PAYMENT_STATUSES).toEqual({
        CREATED: 'created',
        PENDING: 'pending',
        PROCESSING: 'processing',
        SUCCEEDED: 'succeeded',
        FAILED: 'failed',
        CANCELED: 'canceled',
      });
      expect(Object.isFrozen(PAYMENT_STATUSES)).toBe(true);
      expect(Object.isFrozen(CANONICAL_PAYMENT_STATUSES)).toBe(true);
      expect(CANONICAL_PAYMENT_STATUSES).toHaveLength(6);
      expect(isCanonicalPaymentStatus('completed')).toBe(false);
      expect(isCanonicalPaymentStatus('processed')).toBe(false);
    });
  });

  describe('assertTransition', () => {
    test.each(allowedEdges)(
      'allows $from -> $to',
      ({ from, to, meta }) => {
        expect(assertTransition(from, to, meta)).toBe(true);
      }
    );

    test.each(illegalEdges)(
      'rejects illegal edge %s -> %s',
      (from, to) => {
        expect(() => assertTransition(from, to)).toThrow(PaymentTransitionError);
      }
    );

    test.each(CANONICAL_PAYMENT_STATUSES)(
      'classifies same-state %s as an idempotent no-op',
      (status) => {
        expect(assertTransition(status, status)).toBe(false);
      }
    );

    test.each([
      [undefined, 'missing metadata'],
      [{ source: 'admin_reconcile', actorType: 'admin', reason: 'verified' }, 'missing retryKind'],
      [{ ...adminReconcileMeta, retryKind: 'retry' }, 'wrong retryKind'],
      [{ ...adminReconcileMeta, source: 'payment_api' }, 'wrong source'],
      [{ ...adminReconcileMeta, actorType: 'user' }, 'wrong actorType'],
      [
        {
          retryKind: 'reconcile',
          source: 'admin_reconcile',
          actorType: 'system',
          reason: 'verified',
        },
        'admin source with system actor',
      ],
      [
        {
          retryKind: 'reconcile',
          source: 'system_reconcile',
          actorType: 'admin',
          reason: 'verified',
        },
        'system source with admin actor',
      ],
      [{ ...adminReconcileMeta, reason: '' }, 'empty reason'],
      [{ ...adminReconcileMeta, reason: '   ' }, 'blank reason'],
    ])('rejects failed -> pending with %s (%s)', (meta) => {
      expect(() => assertTransition(S.FAILED, S.PENDING, meta)).toThrow(
        PaymentTransitionError
      );
    });

    test.each([
      ['admin_reconcile/admin', adminReconcileMeta],
      ['system_reconcile/system', systemReconcileMeta],
    ])('allows failed -> pending for %s', (_label, meta) => {
      expect(assertTransition(S.FAILED, S.PENDING, meta)).toBe(true);
    });

    test('rejects an unknown source status', () => {
      expect(() => assertTransition('completed', S.PENDING)).toThrow(
        'unknown source status "completed"'
      );
    });

    test('rejects an unknown target status', () => {
      expect(() => assertTransition(S.PENDING, 'processed')).toThrow(
        'unknown target status "processed"'
      );
    });

    test('exposes deterministic conflict properties', () => {
      let error;
      try {
        assertTransition(S.PENDING, S.SUCCEEDED);
      } catch (caught) {
        error = caught;
      }

      expect(error).toBeInstanceOf(PaymentTransitionError);
      expect(error).toMatchObject({
        name: 'PaymentTransitionError',
        statusCode: 409,
        code: 'PAYMENT_STATUS_CONFLICT',
        from: S.PENDING,
        to: S.SUCCEEDED,
        currentStatus: S.PENDING,
        message: 'Payment status transition from "pending" to "succeeded" is not allowed',
      });
    });
  });

  describe('applyTransition', () => {
    test('applies a transition with an id-and-current-status compare-and-set', async () => {
      const initial = { id: 41, status: S.PENDING, planTier: 'pro' };
      const updated = { ...initial, status: S.PROCESSING };
      const tx = createTx({ reads: [initial, updated], count: 1 });

      const result = await applyTransition(tx, initial.id, S.PROCESSING);

      expect(tx.payment.updateMany).toHaveBeenCalledTimes(1);
      expect(tx.payment.updateMany).toHaveBeenCalledWith({
        where: { id: initial.id, status: S.PENDING },
        data: { status: S.PROCESSING },
      });
      expect(result).toEqual({
        applied: true,
        outcome: 'applied',
        previousStatus: S.PENDING,
        targetStatus: S.PROCESSING,
        currentStatus: S.PROCESSING,
        payment: updated,
      });
    });

    test('returns a same-state no-op without calling updateMany', async () => {
      const payment = { id: 42, status: S.SUCCEEDED };
      const tx = createTx({ reads: [payment] });

      const result = await applyTransition(tx, payment.id, S.SUCCEEDED);

      expect(tx.payment.updateMany).not.toHaveBeenCalled();
      expect(tx.payment.findUnique).toHaveBeenCalledTimes(1);
      expect(result).toEqual({
        applied: false,
        outcome: 'already_at_target',
        previousStatus: S.SUCCEEDED,
        targetStatus: S.SUCCEEDED,
        currentStatus: S.SUCCEEDED,
        payment,
      });
    });

    test('reports already_at_target when a concurrent worker reached the target', async () => {
      const initial = { id: 43, status: S.PROCESSING };
      const concurrent = { ...initial, status: S.SUCCEEDED };
      const tx = createTx({ reads: [initial, concurrent], count: 0 });

      const result = await applyTransition(tx, initial.id, S.SUCCEEDED);

      expect(result).toMatchObject({
        applied: false,
        outcome: 'already_at_target',
        previousStatus: S.PROCESSING,
        targetStatus: S.SUCCEEDED,
        currentStatus: S.SUCCEEDED,
        payment: concurrent,
      });
    });

    test('reports state_changed when a concurrent worker moved elsewhere', async () => {
      const initial = { id: 44, status: S.PROCESSING };
      const concurrent = { ...initial, status: S.FAILED };
      const tx = createTx({ reads: [initial, concurrent], count: 0 });

      const result = await applyTransition(tx, initial.id, S.SUCCEEDED);

      expect(result).toMatchObject({
        applied: false,
        outcome: 'state_changed',
        previousStatus: S.PROCESSING,
        targetStatus: S.SUCCEEDED,
        currentStatus: S.FAILED,
        payment: concurrent,
      });
    });

    test('rejects an illegal transition without calling updateMany', async () => {
      const payment = { id: 45, status: S.PENDING };
      const tx = createTx({ reads: [payment] });

      await expect(applyTransition(tx, payment.id, S.SUCCEEDED)).rejects.toMatchObject({
        name: 'PaymentTransitionError',
        statusCode: 409,
        code: 'PAYMENT_STATUS_CONFLICT',
        from: S.PENDING,
        to: S.SUCCEEDED,
        paymentId: payment.id,
        currentStatus: S.PENDING,
      });
      expect(tx.payment.updateMany).not.toHaveBeenCalled();
    });

    test('throws a clear domain error when the Payment does not exist', async () => {
      const tx = createTx({ reads: [null] });

      await expect(applyTransition(tx, 999, S.PENDING)).rejects.toMatchObject({
        name: 'PaymentNotFoundError',
        statusCode: 404,
        code: 'PAYMENT_NOT_FOUND',
        paymentId: 999,
        message: 'Payment 999 not found',
      });
      expect(tx.payment.updateMany).not.toHaveBeenCalled();
    });

    test.each([
      ['admin reconciliation', adminReconcileMeta],
      ['system reconciliation', systemReconcileMeta],
    ])('applies failed -> pending for trusted %s metadata', async (_label, meta) => {
      const initial = { id: 46, status: S.FAILED };
      const updated = { ...initial, status: S.PENDING };
      const tx = createTx({ reads: [initial, updated], count: 1 });

      const result = await applyTransition(tx, initial.id, S.PENDING, meta);

      expect(result).toMatchObject({
        applied: true,
        outcome: 'applied',
        previousStatus: S.FAILED,
        targetStatus: S.PENDING,
        currentStatus: S.PENDING,
      });
    });

    test('rejects failed -> pending without trusted reconciliation metadata', async () => {
      const payment = { id: 47, status: S.FAILED };
      const tx = createTx({ reads: [payment] });

      await expect(applyTransition(tx, payment.id, S.PENDING)).rejects.toBeInstanceOf(
        PaymentTransitionError
      );
      expect(tx.payment.updateMany).not.toHaveBeenCalled();
    });

    test.each(['completed', 'processed', 'unknown']) (
      'never writes noncanonical target status %s',
      async (targetStatus) => {
        const payment = { id: 48, status: S.PENDING };
        const tx = createTx({ reads: [payment] });

        await expect(applyTransition(tx, payment.id, targetStatus)).rejects.toBeInstanceOf(
          PaymentTransitionError
        );
        expect(tx.payment.updateMany).not.toHaveBeenCalled();
      }
    );

    test('rejects a noncanonical stored status even for a same-state request', async () => {
      const payment = { id: 49, status: 'completed' };
      const tx = createTx({ reads: [payment] });

      await expect(applyTransition(tx, payment.id, 'completed')).rejects.toBeInstanceOf(
        PaymentTransitionError
      );
      expect(tx.payment.updateMany).not.toHaveBeenCalled();
    });
  });

  describe('createPaymentInPendingState', () => {
    test('creates as created, transitions on the supplied tx, and returns pending', async () => {
      const created = { id: 70, userId: 12, planTier: 'pro', status: S.CREATED };
      const pending = { ...created, status: S.PENDING };
      const tx = {
        payment: {
          create: jest.fn().mockResolvedValue(created),
          findUnique: jest
            .fn()
            .mockResolvedValueOnce(created)
            .mockResolvedValueOnce(pending),
          updateMany: jest.fn().mockResolvedValue({ count: 1 }),
        },
      };
      const data = {
        userId: 12,
        planTier: 'pro',
        amount: 2499,
        idempotencyKey: 'initializer-70',
      };
      const meta = {
        source: 'test',
        actorType: 'system',
        reason: 'initialize payment',
      };

      const result = await createPaymentInPendingState(tx, data, meta);

      expect(tx.payment.create).toHaveBeenCalledTimes(1);
      expect(tx.payment.create).toHaveBeenCalledWith({
        data: { ...data, status: S.CREATED },
      });
      expect(tx.payment.updateMany).toHaveBeenCalledWith({
        where: { id: created.id, status: S.CREATED },
        data: { status: S.PENDING },
      });
      expect(result).toBe(pending);
      expect(tx).not.toHaveProperty('user');
      expect(tx).not.toHaveProperty('subscription');
      expect(tx).not.toHaveProperty('stripe');
    });

    test('does not allow caller data to override the created initial status', async () => {
      const created = { id: 71, status: S.CREATED };
      const pending = { ...created, status: S.PENDING };
      const tx = {
        payment: {
          create: jest.fn().mockResolvedValue(created),
          findUnique: jest
            .fn()
            .mockResolvedValueOnce(created)
            .mockResolvedValueOnce(pending),
          updateMany: jest.fn().mockResolvedValue({ count: 1 }),
        },
      };

      await createPaymentInPendingState(tx, {
        userId: 13,
        planTier: 'basico',
        amount: 999,
        idempotencyKey: 'initializer-override',
        status: S.SUCCEEDED,
      });

      expect(tx.payment.create).toHaveBeenCalledWith({
        data: {
          userId: 13,
          planTier: 'basico',
          amount: 999,
          idempotencyKey: 'initializer-override',
          status: S.CREATED,
        },
      });
    });

    test('requires the caller to supply a Prisma transaction/client', async () => {
      await expect(
        createPaymentInPendingState(undefined, { userId: 14 })
      ).rejects.toThrow('A Prisma transaction/client with payment.create is required');
    });
  });
});
