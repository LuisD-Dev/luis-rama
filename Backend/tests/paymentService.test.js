import { jest } from '@jest/globals';
import { setupTestDb } from './helpers/db.setup.js';
import prisma from '../utils/prismaClient.js';
import {
  createPaymentIntent,
  confirmSimulatedPayment,
  createOrReusePayment,
  processPaymentIntentWebhookEvent,
  activateOneTimePaymentEntitlement,
  markPaymentCompleted,
  markPaymentProcessed,
  recordPaymentEvent,
  InvalidPlanError,
  PaymentIdempotencyConflictError,
  PaymentIntentConflictError,
  PaymentConfirmationConflictError,
  PaymentNotFoundError,
  StripePaymentIntentError,
  StripePaymentRequestError,
} from '../services/paymentService.js';
import {
  PAYMENT_STATUSES,
  PaymentTransitionError,
} from '../services/paymentStateMachine.js';

setupTestDb();

describe('paymentService', () => {
  let userId;

  beforeEach(async () => {
    const user = await prisma.user.create({
      data: {
        email: `payment-service-${Date.now()}@example.com`,
        passwordHash: 'hashed',
        name: 'Service Test User',
        role: 'student',
      },
    });
    userId = user.id;
  });

  afterEach(async () => {
    await prisma.paymentEvent.deleteMany({});
    await prisma.subscription.deleteMany({});
    await prisma.payment.deleteMany({});
    await prisma.user.deleteMany({ where: { id: userId } });
  });

  test('createPaymentIntent inserts a pending payment', async () => {
    const payment = await createPaymentIntent({
      userId,
      planTier: 'basico',
      amount: 999,
      currency: 'usd',
      provider: 'stripe',
      idempotencyKey: `intent-${Date.now()}`,
      metadata: { source: 'unit' },
    });

    expect(payment.id).toBeDefined();
    expect(payment.status).toBe('pending');
    expect(payment.planTier).toBe('basico');
    expect(payment.amount).toBe(999);
    expect(payment.provider).toBe('stripe');
    expect(payment.metadata).toContain('unit');
  });

  test('createPaymentIntent initializes created then transitions to pending', async () => {
    const statusWrites = [];
    let row = null;
    const paymentClient = {
      findUnique: jest.fn(async ({ where }) => {
        if (!row) return null;
        if (where.id != null && where.id !== row.id) return null;
        if (where.idempotencyKey != null && where.idempotencyKey !== row.idempotencyKey) {
          return null;
        }
        return { ...row };
      }),
      create: jest.fn(async ({ data }) => {
        statusWrites.push(data.status);
        row = { id: 75, ...data };
        return { ...row };
      }),
      updateMany: jest.fn(async ({ where, data }) => {
        if (row.id !== where.id || row.status !== where.status) return { count: 0 };
        statusWrites.push(data.status);
        row = { ...row, ...data };
        return { count: 1 };
      }),
    };
    const db = {
      payment: paymentClient,
      $transaction: jest.fn(async (callback) => callback({ payment: paymentClient })),
    };

    const result = await createPaymentIntent(
      {
        userId,
        planTier: 'basico',
        amount: 999,
        idempotencyKey: 'service-created-pending',
      },
      { db }
    );

    expect(result.status).toBe(PAYMENT_STATUSES.PENDING);
    expect(statusWrites).toEqual([
      PAYMENT_STATUSES.CREATED,
      PAYMENT_STATUSES.PENDING,
    ]);
    expect(db.$transaction).toHaveBeenCalledTimes(1);
  });

  test('createPaymentIntent returns existing row for duplicate idempotencyKey', async () => {
    const key = `dup-intent-${Date.now()}`;
    const first = await createPaymentIntent({
      userId,
      planTier: 'pro',
      amount: 2499,
      idempotencyKey: key,
    });
    const second = await createPaymentIntent({
      userId,
      planTier: 'pro',
      amount: 2499,
      idempotencyKey: key,
    });

    expect(second.id).toBe(first.id);
    const rows = await prisma.payment.findMany({ where: { idempotencyKey: key } });
    expect(rows).toHaveLength(1);
  });

  test('createPaymentIntent rejects invalid planTier', async () => {
    await expect(
      createPaymentIntent({
        userId,
        planTier: 'enterprise',
        amount: 100,
        idempotencyKey: `bad-plan-${Date.now()}`,
      })
    ).rejects.toBeInstanceOf(InvalidPlanError);
  });

  test('markPaymentCompleted converges pending through processing to succeeded', async () => {
    const payment = await createPaymentIntent({
      userId,
      planTier: 'master',
      amount: 4999,
      idempotencyKey: `complete-${Date.now()}`,
      externalId: 'pi_complete_1',
    });

    const { payment: updated } = await markPaymentCompleted({
      paymentId: payment.id,
      subscriptionExternalId: 'sub_complete_1',
    });

    expect(updated.status).toBe('succeeded');
  });

  test.each([
    { initialStatus: 'created', label: 'created through pending and processing' },
    { initialStatus: 'processing', label: 'processing directly' },
  ])('markPaymentCompleted converges $label to succeeded', async ({ initialStatus }) => {
    const payment = await prisma.payment.create({
      data: {
        userId,
        planTier: 'pro',
        amount: 2499,
        status: initialStatus,
        idempotencyKey: `complete-${initialStatus}-${Date.now()}`,
      },
    });

    const result = await markPaymentCompleted({
      paymentId: payment.id,
      subscriptionExternalId: `sub_complete_${initialStatus}_${payment.id}`,
    });

    expect(result.payment.status).toBe('succeeded');
    expect(result.alreadyCompleted).toBe(false);
  });

  test('markPaymentCompleted creates an active subscription', async () => {
    const payment = await createPaymentIntent({
      userId,
      planTier: 'pro',
      amount: 2499,
      idempotencyKey: `sub-${Date.now()}`,
      externalId: 'pi_sub_1',
    });

    const { subscription } = await markPaymentCompleted({
      paymentId: payment.id,
      subscriptionExternalId: 'sub_ext_1',
    });

    expect(subscription).not.toBeNull();
    expect(subscription.status).toBe('active');
    expect(subscription.planTier).toBe('pro');
    expect(subscription.externalId).toBe('sub_ext_1');
  });

  test('markPaymentCompleted updates user planTier and premium role', async () => {
    const payment = await createPaymentIntent({
      userId,
      planTier: 'basico',
      amount: 999,
      idempotencyKey: `user-plan-${Date.now()}`,
    });

    await markPaymentCompleted({
      paymentId: payment.id,
      subscriptionExternalId: `sub_user_${payment.id}`,
    });

    const user = await prisma.user.findUnique({ where: { id: userId } });
    expect(user.planTier).toBe('basico');
    expect(user.role).toBe('premium');
  });

  test('second markPaymentCompleted is idempotent and invokes entitlement exactly once', async () => {
    const payment = await createPaymentIntent({
      userId,
      planTier: 'pro',
      amount: 2499,
      idempotencyKey: `idem-complete-${Date.now()}`,
    });

    const entitlementWriter = jest.fn(async (tx, { payment: succeededPayment }) =>
      tx.user.update({
        where: { id: succeededPayment.userId },
        data: { planTier: succeededPayment.planTier, role: 'premium' },
      })
    );
    const completion = {
      paymentId: payment.id,
      subscriptionExternalId: `sub_idem_${payment.id}`,
    };
    const first = await markPaymentCompleted(completion, { entitlementWriter });
    const second = await markPaymentCompleted(completion, { entitlementWriter });

    expect(first.alreadyCompleted).toBe(false);
    expect(second.alreadyCompleted).toBe(true);
    expect(second.payment.status).toBe('succeeded');
    expect(entitlementWriter).toHaveBeenCalledTimes(1);

    const payments = await prisma.payment.findMany({ where: { id: payment.id } });
    expect(payments).toHaveLength(1);

    const completedEvents = await prisma.paymentEvent.findMany({
      where: { type: 'payment.completed', paymentId: payment.id },
    });
    expect(completedEvents).toHaveLength(1);
  });

  test('default entitlementWriter bumps plan and epoch together', async () => {
    const user = await prisma.user.create({
      data: {
        email: `epoch-writer-${Date.now()}@example.com`,
        passwordHash: 'hashed',
        name: 'Epoch Writer Test',
        role: 'student',
        planTier: 'free',
        entitlementEpoch: 0,
      },
    });

    const payment = await createPaymentIntent({
      userId: user.id,
      planTier: 'pro',
      amount: 2499,
      idempotencyKey: `epoch-writer-${Date.now()}`,
    });

    await markPaymentCompleted({
      paymentId: payment.id,
      subscriptionExternalId: `sub_epoch_writer_${payment.id}`,
    });

    const updated = await prisma.user.findUnique({ where: { id: user.id } });
    expect(updated.planTier).toBe('pro');
    expect(updated.entitlementEpoch).toBe(1);
  });

  test.each([
    { status: 'succeeded', label: 'canonical succeeded' },
    { status: 'completed', label: 'legacy completed' },
    { status: 'processed', label: 'legacy processed' },
  ])('treats $label as already successful without entitlement rewrite', async ({ status }) => {
    const payment = await prisma.payment.create({
      data: {
        userId,
        planTier: 'master',
        amount: 4999,
        status,
        idempotencyKey: `already-success-${status}-${Date.now()}`,
      },
    });
    const entitlementWriter = jest.fn();

    const result = await markPaymentCompleted(
      { paymentId: payment.id },
      { entitlementWriter }
    );

    expect(result).toMatchObject({ alreadyCompleted: true });
    expect(result.payment.status).toBe(status);
    expect(entitlementWriter).not.toHaveBeenCalled();
  });

  test.each(['failed', 'canceled'])(
    'does not resurrect a %s Payment',
    async (status) => {
      const payment = await prisma.payment.create({
        data: {
          userId,
          planTier: 'pro',
          amount: 2499,
          status,
          idempotencyKey: `terminal-${status}-${Date.now()}`,
        },
      });
      const entitlementWriter = jest.fn();

      await expect(
        markPaymentCompleted({ paymentId: payment.id }, { entitlementWriter })
      ).rejects.toBeInstanceOf(PaymentTransitionError);

      const unchanged = await prisma.payment.findUnique({ where: { id: payment.id } });
      expect(unchanged.status).toBe(status);
      expect(entitlementWriter).not.toHaveBeenCalled();
    }
  );

  test('markPaymentProcessed compatibility wrapper produces succeeded', async () => {
    const payment = await createPaymentIntent({
      userId,
      planTier: 'basico',
      amount: 999,
      idempotencyKey: `processed-wrapper-${Date.now()}`,
    });

    const updated = await markPaymentProcessed({ paymentId: payment.id });

    expect(updated.status).toBe('succeeded');
  });

  test('rolls back succeeded when entitlement persistence fails', async () => {
    const payment = await createPaymentIntent({
      userId,
      planTier: 'pro',
      amount: 2499,
      idempotencyKey: `rollback-completion-${Date.now()}`,
    });
    const entitlementFailure = new Error('forced entitlement failure');

    await expect(
      markPaymentCompleted(
        {
          paymentId: payment.id,
          subscriptionExternalId: `sub_rollback_${payment.id}`,
        },
        { entitlementWriter: jest.fn().mockRejectedValue(entitlementFailure) }
      )
    ).rejects.toBe(entitlementFailure);

    const unchanged = await prisma.payment.findUnique({ where: { id: payment.id } });
    expect(unchanged.status).toBe('pending');
    expect(
      await prisma.subscription.findUnique({
        where: {
          provider_externalId: {
            provider: 'stripe',
            externalId: `sub_rollback_${payment.id}`,
          },
        },
      })
    ).toBeNull();
  });

  test('recordPaymentEvent persists payload and ignores duplicate idempotencyKey', async () => {
    const payment = await createPaymentIntent({
      userId,
      planTier: 'basico',
      amount: 999,
      idempotencyKey: `evt-pay-${Date.now()}`,
    });

    const key = `evt-key-${Date.now()}`;
    const { event: first, created: createdFirst } = await recordPaymentEvent({
      paymentId: payment.id,
      type: 'payment.pending',
      payload: { hello: 'world' },
      idempotencyKey: key,
      outcome: 'recorded',
    });
    const { event: second, created: createdSecond } = await recordPaymentEvent({
      paymentId: payment.id,
      type: 'payment.pending',
      payload: { hello: 'again' },
      idempotencyKey: key,
      outcome: 'recorded',
    });

    expect(createdFirst).toBe(true);
    expect(createdSecond).toBe(false);
    expect(second.id).toBe(first.id);
    expect(first.payload).toContain('world');

    const events = await prisma.paymentEvent.findMany({
      where: { idempotencyKey: key },
    });
    expect(events).toHaveLength(1);
  });

  test('markPaymentCompleted throws PaymentNotFoundError for unknown id', async () => {
    await expect(
      markPaymentCompleted({ paymentId: 999999999 })
    ).rejects.toBeInstanceOf(PaymentNotFoundError);
  });

  test('a simulated confirmation CAS loser never invokes the entitlement writer', async () => {
    const processing = {
      id: 901,
      userId,
      planTier: 'pro',
      status: PAYMENT_STATUSES.PROCESSING,
    };
    const succeeded = { ...processing, status: PAYMENT_STATUSES.SUCCEEDED };
    const tx = {
      payment: {
        findUnique: jest.fn().mockResolvedValue(processing),
      },
    };
    const db = {
      $transaction: jest.fn(async (callback) => callback(tx)),
    };
    const transitionPayment = jest.fn().mockResolvedValue({
      applied: false,
      outcome: 'already_at_target',
      previousStatus: PAYMENT_STATUSES.PROCESSING,
      targetStatus: PAYMENT_STATUSES.SUCCEEDED,
      currentStatus: PAYMENT_STATUSES.SUCCEEDED,
      payment: succeeded,
    });
    const entitlementWriter = jest.fn();

    await expect(
      confirmSimulatedPayment(
        { paymentId: processing.id, actorId: 77 },
        { db, transitionPayment, entitlementWriter }
      )
    ).rejects.toBeInstanceOf(PaymentConfirmationConflictError);

    expect(transitionPayment).toHaveBeenCalledTimes(1);
    expect(entitlementWriter).not.toHaveBeenCalled();
  });

  test('repeated simulated confirmations invoke the entitlement writer exactly once', async () => {
    let current = {
      id: 902,
      userId,
      planTier: 'master',
      status: PAYMENT_STATUSES.PENDING,
    };
    const tx = {
      payment: {
        findUnique: jest.fn(async () => ({ ...current })),
      },
    };
    const db = {
      $transaction: jest.fn(async (callback) => callback(tx)),
    };
    const transitionPayment = jest.fn(async (_tx, _paymentId, targetStatus) => {
      const previousStatus = current.status;
      current = { ...current, status: targetStatus };
      return {
        applied: true,
        outcome: 'applied',
        previousStatus,
        targetStatus,
        currentStatus: targetStatus,
        payment: { ...current },
      };
    });
    const entitlementWriter = jest.fn();
    const options = { db, transitionPayment, entitlementWriter };

    await expect(
      confirmSimulatedPayment({ paymentId: current.id, actorId: 77 }, options)
    ).resolves.toMatchObject({ status: PAYMENT_STATUSES.SUCCEEDED });
    await expect(
      confirmSimulatedPayment({ paymentId: current.id, actorId: 77 }, options)
    ).rejects.toBeInstanceOf(PaymentConfirmationConflictError);

    expect(entitlementWriter).toHaveBeenCalledTimes(1);
    expect(transitionPayment).toHaveBeenCalledTimes(2);
  });

  describe('createOrReusePayment Phase 2A protocol', () => {
    const requestFor = (overrides = {}) => ({
      userId,
      paymentMethodId: 'pm_phase_2a',
      planTier: 'basico',
      idempotencyKey: `phase-2a-${Date.now()}`,
      ...overrides,
    });

    test('commits a pending Payment before Stripe is invoked and sends metadata.paymentId', async () => {
      const input = requestFor();
      let paymentVisibleAtStripeCall;
      const requestStripe = jest.fn(async ({ body, idempotencyKey }) => {
        paymentVisibleAtStripeCall = await prisma.payment.findUnique({
          where: { id: Number(body['metadata[paymentId]']) },
        });

        expect(paymentVisibleAtStripeCall).not.toBeNull();
        expect(paymentVisibleAtStripeCall.status).toBe(PAYMENT_STATUSES.PENDING);
        expect(body['metadata[paymentId]']).toBe(
          String(paymentVisibleAtStripeCall.id)
        );
        expect(body['metadata[idempotencyKey]']).toBe(input.idempotencyKey);
        expect(idempotencyKey).toBe(input.idempotencyKey);

        return { id: 'pi_committed_first', status: 'requires_confirmation' };
      });

      const payment = await createOrReusePayment(input, { requestStripe });

      expect(requestStripe).toHaveBeenCalledTimes(1);
      expect(payment.id).toBe(paymentVisibleAtStripeCall.id);
      expect(payment.stripePaymentIntentId).toBe('pi_committed_first');
      expect(payment.status).toBe(PAYMENT_STATUSES.PENDING);
      expect(payment.planTier).toBe(input.planTier);
    });

    test('reuses the same Payment and does not create another Stripe intent once attached', async () => {
      const input = requestFor();
      const requestStripe = jest
        .fn()
        .mockResolvedValue({ id: 'pi_same_request', status: 'requires_action' });

      const first = await createOrReusePayment(input, { requestStripe });
      const second = await createOrReusePayment(input, { requestStripe });

      expect(second.id).toBe(first.id);
      expect(second.stripePaymentIntentId).toBe(first.stripePaymentIntentId);
      expect(requestStripe).toHaveBeenCalledTimes(1);
      await expect(
        prisma.payment.count({ where: { idempotencyKey: input.idempotencyKey } })
      ).resolves.toBe(1);
    });

    test('rejects cross-user idempotency-key reuse without calling Stripe or exposing identifiers', async () => {
      const owner = await prisma.user.create({
        data: {
          email: `payment-owner-${Date.now()}@example.com`,
          passwordHash: 'hashed',
          name: 'Payment Owner',
        },
      });
      const key = `cross-user-${Date.now()}`;
      const existing = await prisma.payment.create({
        data: {
          userId: owner.id,
          amount: 999,
          currency: 'usd',
          planTier: 'basico',
          provider: 'stripe',
          paymentMethodId: 'pm_phase_2a',
          stripePaymentIntentId: 'pi_private_owner',
          idempotencyKey: key,
          status: PAYMENT_STATUSES.PENDING,
        },
      });
      const requestStripe = jest.fn();

      let error;
      try {
        await createOrReusePayment(requestFor({ idempotencyKey: key }), {
          requestStripe,
        });
      } catch (caught) {
        error = caught;
      }

      expect(error).toBeInstanceOf(PaymentIdempotencyConflictError);
      expect(error).toMatchObject({
        statusCode: 409,
        code: 'PAYMENT_IDEMPOTENCY_CONFLICT',
      });
      expect(error.message).not.toContain(String(existing.id));
      expect(error.message).not.toContain(existing.stripePaymentIntentId);
      expect(error).not.toHaveProperty('paymentId');
      expect(error).not.toHaveProperty('stripePaymentIntentId');
      expect(requestStripe).not.toHaveBeenCalled();
    });

    test('rejects idempotency-key reuse with a different plan and derived amount', async () => {
      const key = `different-plan-${Date.now()}`;
      await prisma.payment.create({
        data: {
          userId,
          amount: 999,
          currency: 'usd',
          planTier: 'basico',
          provider: 'stripe',
          paymentMethodId: 'pm_phase_2a',
          idempotencyKey: key,
          status: PAYMENT_STATUSES.PENDING,
        },
      });
      const requestStripe = jest.fn();

      await expect(
        createOrReusePayment(
          requestFor({ idempotencyKey: key, planTier: 'pro' }),
          { requestStripe }
        )
      ).rejects.toMatchObject({
        statusCode: 409,
        code: 'PAYMENT_IDEMPOTENCY_CONFLICT',
      });
      expect(requestStripe).not.toHaveBeenCalled();
    });

    test('recovers an idempotency-key P2002 race outside the rolled-back transaction', async () => {
      const input = requestFor({ idempotencyKey: 'p2002-race' });
      const racedPayment = {
        id: 501,
        userId,
        amount: 999,
        currency: 'usd',
        planTier: 'basico',
        provider: 'stripe',
        paymentMethodId: input.paymentMethodId,
        idempotencyKey: input.idempotencyKey,
        stripePaymentIntentId: 'pi_race_winner',
        status: PAYMENT_STATUSES.PENDING,
      };
      const uniqueError = Object.assign(new Error('unique constraint'), {
        code: 'P2002',
        meta: { target: ['idempotency_key'] },
      });
      const db = {
        $transaction: jest.fn().mockRejectedValue(uniqueError),
        payment: {
          findUnique: jest.fn().mockResolvedValue(racedPayment),
        },
      };
      const requestStripe = jest.fn();

      const result = await createOrReusePayment(input, { db, requestStripe });

      expect(result).toBe(racedPayment);
      expect(db.payment.findUnique).toHaveBeenCalledWith({
        where: { idempotencyKey: input.idempotencyKey },
      });
      expect(requestStripe).not.toHaveBeenCalled();
    });

    test('attaches a Stripe PaymentIntent ID when the committed Payment has none', async () => {
      const input = requestFor();
      const payment = await createOrReusePayment(input, {
        requestStripe: jest
          .fn()
          .mockResolvedValue({ id: 'pi_attach_null', status: 'requires_action' }),
      });

      expect(payment.stripePaymentIntentId).toBe('pi_attach_null');
      const stored = await prisma.payment.findUnique({ where: { id: payment.id } });
      expect(stored.stripePaymentIntentId).toBe('pi_attach_null');
      expect(stored.externalId).toBe('pi_attach_null');
    });

    test('rejects a different concurrently attached Stripe PaymentIntent ID and preserves the winner', async () => {
      const input = requestFor();
      let paymentId;
      const requestStripe = jest.fn(async ({ body }) => {
        paymentId = Number(body['metadata[paymentId]']);
        await prisma.payment.update({
          where: { id: paymentId },
          data: {
            stripePaymentIntentId: 'pi_concurrent_winner',
            externalId: 'pi_concurrent_winner',
          },
        });
        return { id: 'pi_conflicting_response', status: 'processing' };
      });

      await expect(
        createOrReusePayment(input, { requestStripe })
      ).rejects.toBeInstanceOf(PaymentIntentConflictError);

      const stored = await prisma.payment.findUnique({ where: { id: paymentId } });
      expect(stored.stripePaymentIntentId).toBe('pi_concurrent_winner');
      expect(stored.externalId).toBe('pi_concurrent_winner');
      expect(stored.status).toBe(PAYMENT_STATUSES.PENDING);
    });

    test.each([
      ['processing', PAYMENT_STATUSES.PROCESSING],
      ['requires_capture', PAYMENT_STATUSES.PROCESSING],
      ['canceled', PAYMENT_STATUSES.CANCELED],
      ['requires_payment_method', PAYMENT_STATUSES.FAILED],
    ])(
      'converges authoritative Stripe %s through the state machine to %s',
      async (stripeStatus, expectedStatus) => {
        const input = requestFor({
          idempotencyKey: `stripe-status-${stripeStatus}-${Date.now()}`,
        });

        const payment = await createOrReusePayment(input, {
          requestStripe: jest.fn().mockResolvedValue({
            id: `pi_${stripeStatus}`,
            status: stripeStatus,
          }),
        });

        expect(payment.status).toBe(expectedStatus);
        expect(['completed', 'processed']).not.toContain(payment.status);
      }
    );

    test('maps Stripe succeeded only to processing so webhook finalization owns succeeded entitlement', async () => {
      const input = requestFor();
      const payment = await createOrReusePayment(input, {
        requestStripe: jest
          .fn()
          .mockResolvedValue({ id: 'pi_sync_succeeded', status: 'succeeded' }),
      });

      expect(payment.status).toBe(PAYMENT_STATUSES.PROCESSING);
      expect(payment.planTier).toBe(input.planTier);
      const stored = await prisma.payment.findUnique({ where: { id: payment.id } });
      expect(stored.status).toBe(PAYMENT_STATUSES.PROCESSING);
      expect(stored.status).not.toBe(PAYMENT_STATUSES.SUCCEEDED);
    });

    test('leaves an ambiguous Stripe transport failure committed and reusable', async () => {
      const input = requestFor();
      const timeout = Object.assign(new Error('socket timeout'), {
        code: 'ETIMEDOUT',
      });

      await expect(
        createOrReusePayment(input, {
          requestStripe: jest.fn().mockRejectedValue(timeout),
        })
      ).rejects.toMatchObject({
        name: 'StripePaymentRequestError',
        statusCode: 502,
        code: 'PAYMENT_PROVIDER_UNAVAILABLE',
        retryable: true,
      });

      const committed = await prisma.payment.findUnique({
        where: { idempotencyKey: input.idempotencyKey },
      });
      expect(committed).not.toBeNull();
      expect(committed.status).toBe(PAYMENT_STATUSES.PENDING);
      expect(committed.stripePaymentIntentId).toBeNull();

      const retried = await createOrReusePayment(input, {
        requestStripe: jest
          .fn()
          .mockResolvedValue({ id: 'pi_after_timeout', status: 'requires_action' }),
      });
      expect(retried.id).toBe(committed.id);
      expect(retried.stripePaymentIntentId).toBe('pi_after_timeout');
      expect(retried.status).toBe(PAYMENT_STATUSES.PENDING);
    });

    test('does not mark failed on a malformed Stripe response', async () => {
      const input = requestFor();

      await expect(
        createOrReusePayment(input, {
          requestStripe: jest.fn().mockResolvedValue({ id: 'pi_missing_status' }),
        })
      ).rejects.toBeInstanceOf(StripePaymentRequestError);

      const committed = await prisma.payment.findUnique({
        where: { idempotencyKey: input.idempotencyKey },
      });
      expect(committed.status).toBe(PAYMENT_STATUSES.PENDING);
      expect(committed.stripePaymentIntentId).toBe('pi_missing_status');
    });

    test('treats a rejected embedded PaymentIntent without status as retryable', async () => {
      const input = requestFor();
      const stripeError = {
        error: {
          payment_intent: {
            id: 'pi_partial',
          },
        },
      };

      let error;
      try {
        await createOrReusePayment(input, {
          requestStripe: jest.fn().mockRejectedValue(stripeError),
        });
      } catch (caught) {
        error = caught;
      }

      expect(error).toBeInstanceOf(StripePaymentRequestError);
      expect(error).not.toBeInstanceOf(StripePaymentIntentError);
      expect(error).toMatchObject({
        statusCode: 502,
        code: 'PAYMENT_PROVIDER_UNAVAILABLE',
        retryable: true,
      });

      const committed = await prisma.payment.findUnique({
        where: { idempotencyKey: input.idempotencyKey },
      });
      expect(committed.status).toBe(PAYMENT_STATUSES.PENDING);
      expect(committed.stripePaymentIntentId).toBe('pi_partial');
    });

    test('treats a rejected embedded PaymentIntent with unknown status as retryable', async () => {
      const input = requestFor();
      const stripeError = {
        error: {
          payment_intent: {
            id: 'pi_unknown',
            status: 'future_status',
          },
        },
      };

      let error;
      try {
        await createOrReusePayment(input, {
          requestStripe: jest.fn().mockRejectedValue(stripeError),
        });
      } catch (caught) {
        error = caught;
      }

      expect(error).toBeInstanceOf(StripePaymentRequestError);
      expect(error).not.toBeInstanceOf(StripePaymentIntentError);
      expect(error).toMatchObject({
        statusCode: 502,
        code: 'PAYMENT_PROVIDER_UNAVAILABLE',
        retryable: true,
      });

      const committed = await prisma.payment.findUnique({
        where: { idempotencyKey: input.idempotencyKey },
      });
      expect(committed.status).toBe(PAYMENT_STATUSES.PENDING);
      expect(committed.stripePaymentIntentId).toBe('pi_unknown');
    });

    test('treats a resolved PaymentIntent with unknown status as retryable', async () => {
      const input = requestFor();

      await expect(
        createOrReusePayment(input, {
          requestStripe: jest.fn().mockResolvedValue({
            id: 'pi_unknown_resolved',
            status: 'future_status',
          }),
        })
      ).rejects.toMatchObject({
        name: 'StripePaymentRequestError',
        statusCode: 502,
        code: 'PAYMENT_PROVIDER_UNAVAILABLE',
        retryable: true,
      });

      const committed = await prisma.payment.findUnique({
        where: { idempotencyKey: input.idempotencyKey },
      });
      expect(committed.status).toBe(PAYMENT_STATUSES.PENDING);
      expect(committed.stripePaymentIntentId).toBe('pi_unknown_resolved');
    });

    test('converges a recognized embedded requires_payment_method status before returning 402', async () => {
      const input = requestFor();
      const stripeError = {
        error: {
          payment_intent: {
            id: 'pi_embedded_requires_payment_method',
            status: 'requires_payment_method',
          },
        },
      };

      await expect(
        createOrReusePayment(input, {
          requestStripe: jest.fn().mockRejectedValue(stripeError),
        })
      ).rejects.toMatchObject({
        name: 'StripePaymentIntentError',
        statusCode: 402,
        code: 'STRIPE_PAYMENT_INTENT_FAILED',
        retryable: false,
      });

      const committed = await prisma.payment.findUnique({
        where: { idempotencyKey: input.idempotencyKey },
      });
      expect(committed.status).toBe(PAYMENT_STATUSES.FAILED);
      expect(committed.stripePaymentIntentId).toBe(
        'pi_embedded_requires_payment_method'
      );
    });

    test.each([
      PAYMENT_STATUSES.SUCCEEDED,
      PAYMENT_STATUSES.FAILED,
      PAYMENT_STATUSES.CANCELED,
      'completed',
      'processed',
    ])('does not resurrect terminal existing status %s', async (status) => {
      const input = requestFor({ idempotencyKey: `terminal-${status}` });
      const existing = {
        id: 550,
        userId,
        amount: 999,
        currency: 'usd',
        planTier: 'basico',
        provider: 'stripe',
        paymentMethodId: input.paymentMethodId,
        idempotencyKey: input.idempotencyKey,
        stripePaymentIntentId: null,
        status,
      };
      const tx = {
        payment: { findUnique: jest.fn().mockResolvedValue(existing) },
      };
      const db = {
        $transaction: jest.fn(async (callback) => callback(tx)),
        payment: { findUnique: jest.fn() },
      };
      const requestStripe = jest.fn();

      const result = await createOrReusePayment(input, { db, requestStripe });

      expect(result).toBe(existing);
      expect(requestStripe).not.toHaveBeenCalled();
    });

    test('does not classify an unrelated P2002 as idempotent reuse', async () => {
      const input = requestFor();
      const unrelated = Object.assign(new Error('different unique constraint'), {
        code: 'P2002',
        meta: { target: ['stripe_payment_intent_id'] },
      });
      const db = {
        $transaction: jest.fn().mockRejectedValue(unrelated),
        payment: { findUnique: jest.fn() },
      };

      await expect(
        createOrReusePayment(input, { db, requestStripe: jest.fn() })
      ).rejects.toBe(unrelated);
      expect(db.payment.findUnique).not.toHaveBeenCalled();
    });

    test('uses only created insertion and canonical state-machine status writes', async () => {
      const input = requestFor();
      const statusWrites = [];
      let row = null;
      const paymentClient = {
        findUnique: jest.fn(async ({ where }) => {
          if (!row) return null;
          if (where.id != null && row.id !== where.id) return null;
          if (
            where.idempotencyKey != null &&
            row.idempotencyKey !== where.idempotencyKey
          ) {
            return null;
          }
          return { ...row };
        }),
        create: jest.fn(async ({ data }) => {
          statusWrites.push(data.status);
          row = {
            id: 601,
            stripePaymentIntentId: null,
            externalId: null,
            ...data,
          };
          return { ...row };
        }),
        updateMany: jest.fn(async ({ where, data }) => {
          const matches =
            row?.id === where.id &&
            (where.status === undefined || row.status === where.status) &&
            (where.stripePaymentIntentId === undefined ||
              row.stripePaymentIntentId === where.stripePaymentIntentId);
          if (!matches) return { count: 0 };
          if (data.status !== undefined) statusWrites.push(data.status);
          row = { ...row, ...data };
          return { count: 1 };
        }),
      };
      const db = {
        payment: paymentClient,
        $transaction: jest.fn(async (callback) => callback({ payment: paymentClient })),
      };

      const result = await createOrReusePayment(input, {
        db,
        requestStripe: jest
          .fn()
          .mockResolvedValue({ id: 'pi_canonical_only', status: 'succeeded' }),
      });

      expect(result.status).toBe(PAYMENT_STATUSES.PROCESSING);
      expect(statusWrites).toEqual([
        PAYMENT_STATUSES.CREATED,
        PAYMENT_STATUSES.PENDING,
        PAYMENT_STATUSES.PROCESSING,
      ]);
      expect(statusWrites).not.toEqual(
        expect.arrayContaining(['completed', 'processed'])
      );
    });
  });

  describe('PaymentIntent webhook Phase 2B protocol', () => {
    const successEvent = ({ id, payment }) => ({
      id,
      type: 'payment_intent.succeeded',
      data: {
        object: {
          id: payment.stripePaymentIntentId,
          metadata: { paymentId: String(payment.id) },
        },
      },
    });

    test('two distinct success event IDs persist independently but call the entitlement writer once', async () => {
      const payment = await prisma.payment.create({
        data: {
          userId,
          amount: 2499,
          currency: 'usd',
          planTier: 'pro',
          provider: 'stripe',
          paymentMethodId: 'pm_two_success_events',
          stripePaymentIntentId: 'pi_two_success_events',
          idempotencyKey: `two-success-events-${Date.now()}`,
          status: PAYMENT_STATUSES.PENDING,
        },
      });
      const entitlementWriter = jest.fn(
        (tx, args) => activateOneTimePaymentEntitlement(tx, args)
      );

      const first = await processPaymentIntentWebhookEvent({
        event: successEvent({ id: 'evt_distinct_success_a', payment }),
        entitlementWriter,
      });
      const second = await processPaymentIntentWebhookEvent({
        event: successEvent({ id: 'evt_distinct_success_b', payment }),
        entitlementWriter,
      });

      expect(first).toMatchObject({
        outcome: 'processed',
        entitlementActivated: true,
      });
      expect(second).toMatchObject({
        outcome: 'already_succeeded',
        entitlementActivated: false,
      });
      expect(entitlementWriter).toHaveBeenCalledTimes(1);
      await expect(
        prisma.payment.findUnique({ where: { id: payment.id } })
      ).resolves.toMatchObject({ status: PAYMENT_STATUSES.SUCCEEDED });
      const events = await prisma.paymentEvent.findMany({
        where: {
          stripeEventId: {
            in: ['evt_distinct_success_a', 'evt_distinct_success_b'],
          },
        },
      });
      expect(events).toHaveLength(2);
      expect(events.map((event) => event.outcome).sort()).toEqual([
        'already_succeeded',
        'processed',
      ]);
    });

    test('a duplicate event ID returns duplicate without invoking the real entitlement writer twice', async () => {
      const payment = await prisma.payment.create({
        data: {
          userId,
          amount: 2499,
          currency: 'usd',
          planTier: 'pro',
          provider: 'stripe',
          paymentMethodId: 'pm_duplicate_entitlement',
          stripePaymentIntentId: 'pi_duplicate_entitlement',
          idempotencyKey: `duplicate-entitlement-${Date.now()}`,
          status: PAYMENT_STATUSES.PENDING,
        },
      });
      const event = successEvent({
        id: 'evt_duplicate_entitlement_once',
        payment,
      });
      const entitlementWriter = jest.fn(
        (tx, args) => activateOneTimePaymentEntitlement(tx, args)
      );

      const first = await processPaymentIntentWebhookEvent({
        event,
        entitlementWriter,
      });
      const duplicate = await processPaymentIntentWebhookEvent({
        event,
        entitlementWriter,
      });

      expect(first).toMatchObject({
        outcome: 'processed',
        entitlementActivated: true,
      });
      expect(duplicate).toMatchObject({
        outcome: 'duplicate',
        entitlementActivated: false,
      });
      expect(entitlementWriter).toHaveBeenCalledTimes(1);
      await expect(
        prisma.paymentEvent.findMany({
          where: { stripeEventId: event.id },
        })
      ).resolves.toHaveLength(1);
      await expect(
        prisma.payment.findUnique({ where: { id: payment.id } })
      ).resolves.toMatchObject({ status: PAYMENT_STATUSES.SUCCEEDED });
    });

    test('handles a duplicate P2002 only after the transaction rejects and preserves the original event outcome', async () => {
      const uniqueError = Object.assign(new Error('event claim conflict'), {
        code: 'P2002',
      });
      const committedEvent = {
        id: 71,
        paymentId: 44,
        stripeEventId: 'evt_committed_duplicate',
        outcome: 'processed',
      };
      const db = {
        $transaction: jest.fn().mockRejectedValue(uniqueError),
        paymentEvent: {
          findUnique: jest.fn().mockResolvedValue(committedEvent),
        },
      };

      const result = await processPaymentIntentWebhookEvent({
        event: {
          id: committedEvent.stripeEventId,
          type: 'payment_intent.succeeded',
        },
        db,
      });

      expect(result).toMatchObject({
        outcome: 'duplicate',
        paymentId: committedEvent.paymentId,
        entitlementActivated: false,
      });
      expect(db.$transaction).toHaveBeenCalledTimes(1);
      expect(db.paymentEvent.findUnique).toHaveBeenCalledWith({
        where: { stripeEventId: committedEvent.stripeEventId },
      });
      expect(committedEvent.outcome).toBe('processed');
    });

    test('does not classify an unrelated P2002 as a duplicate without the exact stripeEventId', async () => {
      const uniqueError = Object.assign(new Error('unrelated unique conflict'), {
        code: 'P2002',
        meta: { target: ['provider', 'external_id'] },
      });
      const db = {
        $transaction: jest.fn().mockRejectedValue(uniqueError),
        paymentEvent: {
          findUnique: jest.fn().mockResolvedValue(null),
        },
      };

      await expect(
        processPaymentIntentWebhookEvent({
          event: {
            id: 'evt_not_the_unique_conflict',
            type: 'payment_intent.succeeded',
          },
          db,
        })
      ).rejects.toBe(uniqueError);
      expect(db.paymentEvent.findUnique).toHaveBeenCalledWith({
        where: { stripeEventId: 'evt_not_the_unique_conflict' },
      });
    });
  });
});
