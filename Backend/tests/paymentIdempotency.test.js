import request from 'supertest';
import jwt from 'jsonwebtoken';
import crypto from 'crypto';
import app from '../app.js';
import { setupTestDb } from './helpers/db.setup.js';
import prisma from '../utils/prismaClient.js';
import {
  PAYMENT_STATUSES,
  applyTransition,
} from '../services/paymentStateMachine.js';

setupTestDb();

describe('Payment idempotency', () => {
  let authToken;
  let testUserId;

  const createLocalPayment = (overrides = {}) =>
    prisma.payment.create({
      data: {
        userId: testUserId,
        amount: 999,
        currency: 'usd',
        planTier: 'pro',
        provider: 'stripe',
        paymentMethodId: 'pm_phase_2b',
        idempotencyKey: `phase-2b-${Date.now()}-${Math.random()}`,
        status: 'pending',
        ...overrides,
      },
    });

  const paymentIntentEvent = ({
    id,
    type = 'payment_intent.succeeded',
    paymentIntentId,
    paymentId,
  }) => ({
    id,
    type,
    data: {
      object: {
        id: paymentIntentId,
        metadata: paymentId == null ? {} : { paymentId: String(paymentId) },
      },
    },
  });

  const postOneTimeWebhook = (event) =>
    request(app)
      .post('/api/webhooks/stripe')
      .set('Content-Type', 'application/json')
      .send(event);

  beforeEach(async () => {
    if (!process.env.JWT_SECRET) {
      process.env.JWT_SECRET = 'test_jwt_secret';
    }
    const user = await prisma.user.create({
      data: {
        email: `test-payments-${Date.now()}@example.com`,
        passwordHash: 'hashed-password',
        name: 'Payment User',
      },
    });
    testUserId = user.id;
    authToken = jwt.sign(
      { id: user.id, role: user.role, iat: Math.floor(Date.now() / 1000), exp: Math.floor(Date.now() / 1000) + 3600 },
      process.env.JWT_SECRET
    );
  });

  afterEach(async () => {
    await prisma.paymentEvent.deleteMany({});
    await prisma.subscription.deleteMany({});
    await prisma.payment.deleteMany({});
    await prisma.user.deleteMany({ where: { id: testUserId } });
  });

  afterAll(async () => {
    await prisma.$disconnect();
  });

  test('posting same idempotencyKey twice creates a single Payment', async () => {
    const payload = { paymentMethodId: 'pm_test_123', planTier: 'basico' };
    const idempotencyKey = `test-key-${Date.now()}`;

    const res1 = await request(app)
      .post('/api/payments/payment-method')
      .set('Authorization', `Bearer ${authToken}`)
      .set('Idempotency-Key', idempotencyKey)
      .send(payload);
    expect(res1.statusCode).toBe(200);
    expect(res1.body).toEqual({
      paymentId: expect.any(Number),
      stripePaymentIntentId: expect.any(String),
      status: 'pending',
      planTier: 'basico',
    });

    const res2 = await request(app)
      .post('/api/payments/payment-method')
      .set('Authorization', `Bearer ${authToken}`)
      .set('Idempotency-Key', idempotencyKey)
      .send(payload);
    expect(res2.statusCode).toBe(200);
    expect(res2.body.paymentId).toBe(res1.body.paymentId);
    expect(res2.body.stripePaymentIntentId).toBe(
      res1.body.stripePaymentIntentId
    );
    expect(res2.body).toEqual(res1.body);

    // Check DB for only one payment with that idempotencyKey
    const payments = await prisma.payment.findMany({ where: { idempotencyKey } });
    expect(payments.length).toBe(1);
  }, 20000);

  test('returns a processing Payment with its persisted plan tier', async () => {
    const idempotencyKey = `processing-response-${Date.now()}`;
    const existing = await prisma.payment.create({
      data: {
        userId: testUserId,
        amount: 4999,
        currency: 'usd',
        planTier: 'master',
        provider: 'stripe',
        paymentMethodId: 'pm_processing_response',
        idempotencyKey,
        status: 'processing',
      },
    });

    const response = await request(app)
      .post('/api/payments/payment-method')
      .set('Authorization', `Bearer ${authToken}`)
      .set('Idempotency-Key', idempotencyKey)
      .send({ paymentMethodId: 'pm_processing_response', planTier: 'master' });

    expect(response.statusCode).toBe(200);
    expect(response.body).toEqual({
      paymentId: existing.id,
      stripePaymentIntentId: expect.any(String),
      status: 'processing',
      planTier: 'master',
    });
  }, 20000);

  test('returns HTTP 409 for an incompatible cross-user idempotency key without leaking identifiers', async () => {
    const owner = await prisma.user.create({
      data: {
        email: `payment-conflict-owner-${Date.now()}@example.com`,
        passwordHash: 'hashed-password',
        name: 'Conflict Owner',
      },
    });
    const idempotencyKey = `http-conflict-${Date.now()}`;
    const existing = await prisma.payment.create({
      data: {
        userId: owner.id,
        amount: 999,
        currency: 'usd',
        planTier: 'basico',
        provider: 'stripe',
        paymentMethodId: 'pm_private_owner',
        stripePaymentIntentId: 'pi_private_owner_http_conflict',
        idempotencyKey,
        status: 'pending',
      },
    });

    const response = await request(app)
      .post('/api/payments/payment-method')
      .set('Authorization', `Bearer ${authToken}`)
      .set('Idempotency-Key', idempotencyKey)
      .send({ paymentMethodId: 'pm_test_requester', planTier: 'basico' });

    expect(response.statusCode).toBe(409);
    expect(response.body).toEqual({
      error: 'The idempotency key was already used for another payment request.',
      code: 'PAYMENT_IDEMPOTENCY_CONFLICT',
    });
    expect(JSON.stringify(response.body)).not.toContain(
      existing.stripePaymentIntentId
    );
    expect(response.body).not.toHaveProperty('paymentId');
    expect(response.body).not.toHaveProperty('stripePaymentIntentId');
  }, 20000);

  test('delegates an unexpected ordinary payment error to the global error handler', async () => {
    const now = Math.floor(Date.now() / 1000);
    const missingUserToken = jwt.sign(
      { id: 2147483647, role: 'student', iat: now, exp: now + 3600 },
      process.env.JWT_SECRET
    );

    const response = await request(app)
      .post('/api/payments/payment-method')
      .set('Authorization', `Bearer ${missingUserToken}`)
      .set('Idempotency-Key', `ordinary-error-${Date.now()}`)
      .send({ paymentMethodId: 'pm_missing_user', planTier: 'basico' });

    expect(response.statusCode).toBe(500);
    expect(response.body).toEqual({ error: 'Internal server error' });
  }, 20000);

  test('duplicate Stripe webhook delivery returns 200 and records a single PaymentEvent without reprocessing', async () => {
    const payment = await prisma.payment.create({
      data: {
        user: { connect: { id: testUserId } },
        amount: 999,
        currency: 'usd',
        planTier: 'pro',
        paymentMethodId: 'pm_test_webhook',
        stripePaymentIntentId: 'pi_test_webhook_dup',
        idempotencyKey: `webhook-${Date.now()}`,
        status: 'pending',
      },
    });

    const eventPayload = {
      id: 'evt_test_webhook_duplicate',
      type: 'payment_intent.succeeded',
      data: {
        object: {
          id: payment.stripePaymentIntentId,
          metadata: {
            paymentId: String(payment.id),
            idempotencyKey: payment.idempotencyKey,
          },
        },
      },
    };

    const res1 = await request(app)
      .post('/api/webhooks/stripe')
      .set('Content-Type', 'application/json')
      .send(eventPayload);

    expect(res1.statusCode).toBe(200);

    const paymentAfterFirst = await prisma.payment.findUnique({ where: { id: payment.id } });
    expect(paymentAfterFirst.status).toBe('succeeded');

    const firstEvent = await prisma.paymentEvent.findUnique({ where: { stripeEventId: eventPayload.id } });
    expect(firstEvent).not.toBeNull();
    expect(firstEvent.outcome).toBe('processed');
    expect(firstEvent.processedAt).not.toBeNull();
    expect(firstEvent.idempotencyKey).toBe(`stripe:${eventPayload.id}`);

    const res2 = await request(app)
      .post('/api/webhooks/stripe')
      .set('Content-Type', 'application/json')
      .send(eventPayload);

    expect(res2.statusCode).toBe(200);
    expect(res2.text).toMatch(/duplicate|ok/i);

    const paymentEvents = await prisma.paymentEvent.findMany({ where: { stripeEventId: eventPayload.id } });
    expect(paymentEvents.length).toBe(1);

    const paymentAfterSecond = await prisma.payment.findUnique({ where: { id: payment.id } });
    expect(paymentAfterSecond.status).toBe('succeeded');

    const originalEventAfterDuplicate = await prisma.paymentEvent.findUnique({
      where: { stripeEventId: eventPayload.id },
    });
    expect(originalEventAfterDuplicate.outcome).toBe('processed');
    expect(
      await prisma.paymentEvent.count({ where: { outcome: 'processing' } })
    ).toBe(0);

    const userAfter = await prisma.user.findUnique({ where: { id: payment.userId } });
    expect(userAfter.planTier).toBe('pro');
    expect(userAfter.role).toBe('premium');
  }, 20000);

  test('API pending payment converges to succeeded and activates its plan in the webhook transaction', async () => {
    const idempotencyKey = `api-to-webhook-${Date.now()}`;
    const apiResponse = await request(app)
      .post('/api/payments/payment-method')
      .set('Authorization', `Bearer ${authToken}`)
      .set('Idempotency-Key', idempotencyKey)
      .send({ paymentMethodId: 'pm_api_to_webhook', planTier: 'basico' });

    expect(apiResponse.statusCode).toBe(200);
    expect(apiResponse.body.status).toBe('pending');

    const event = paymentIntentEvent({
      id: 'evt_api_pending_success',
      paymentIntentId: apiResponse.body.stripePaymentIntentId,
      paymentId: apiResponse.body.paymentId,
    });
    const webhookResponse = await postOneTimeWebhook(event);

    expect(webhookResponse.statusCode).toBe(200);
    const payment = await prisma.payment.findUnique({
      where: { id: apiResponse.body.paymentId },
    });
    const user = await prisma.user.findUnique({ where: { id: testUserId } });
    const storedEvent = await prisma.paymentEvent.findUnique({
      where: { stripeEventId: event.id },
    });
    expect(payment.status).toBe('succeeded');
    expect(user).toMatchObject({ planTier: 'basico', role: 'premium' });
    expect(storedEvent).toMatchObject({
      paymentId: payment.id,
      outcome: 'processed',
    });
    expect(storedEvent.processedAt).not.toBeNull();
  }, 20000);

  test('webhook before PI persistence resolves metadata.paymentId and attaches the Stripe identity', async () => {
    const payment = await createLocalPayment({
      stripePaymentIntentId: null,
      externalId: null,
    });
    const event = paymentIntentEvent({
      id: 'evt_webhook_before_pi_attachment',
      paymentIntentId: 'pi_webhook_first',
      paymentId: payment.id,
    });

    const response = await postOneTimeWebhook(event);

    expect(response.statusCode).toBe(200);
    const storedPayment = await prisma.payment.findUnique({
      where: { id: payment.id },
    });
    const user = await prisma.user.findUnique({ where: { id: testUserId } });
    const storedEvent = await prisma.paymentEvent.findUnique({
      where: { stripeEventId: event.id },
    });
    expect(storedPayment).toMatchObject({
      status: 'succeeded',
      stripePaymentIntentId: 'pi_webhook_first',
      externalId: 'pi_webhook_first',
    });
    expect(user).toMatchObject({ planTier: 'pro', role: 'premium' });
    expect(storedEvent.outcome).toBe('processed');
    expect(storedEvent.processedAt).not.toBeNull();
  }, 20000);

  test('rolls back claim, succeeded transition, subscription, and user entitlement when entitlement persistence fails, then accepts the same retry', async () => {
    const payment = await createLocalPayment({
      stripePaymentIntentId: null,
      externalId: null,
    });
    const event = paymentIntentEvent({
      id: 'evt_entitlement_rollback_retry',
      paymentIntentId: 'pi_entitlement_rollback_retry',
      paymentId: payment.id,
    });
    const triggerName = 'phase2b_force_entitlement_failure';

    await prisma.$executeRawUnsafe(`DROP TRIGGER IF EXISTS ${triggerName}`);
    await prisma.$executeRawUnsafe(`
      CREATE TRIGGER ${triggerName}
      BEFORE UPDATE OF plan_tier ON users
      WHEN OLD.id = ${testUserId}
      BEGIN
        SELECT RAISE(ABORT, 'forced entitlement failure');
      END
    `);

    try {
      const failedResponse = await postOneTimeWebhook(event);
      expect(failedResponse.statusCode).toBe(500);

      const rolledBackPayment = await prisma.payment.findUnique({
        where: { id: payment.id },
      });
      const rolledBackUser = await prisma.user.findUnique({
        where: { id: testUserId },
      });
      expect(rolledBackPayment).toMatchObject({
        status: 'pending',
        stripePaymentIntentId: null,
      });
      expect(rolledBackUser).toMatchObject({ planTier: null, role: 'student' });
      await expect(
        prisma.paymentEvent.findUnique({ where: { stripeEventId: event.id } })
      ).resolves.toBeNull();
      await expect(
        prisma.subscription.findUnique({
          where: {
            provider_externalId: {
              provider: 'stripe',
              externalId: 'pi_entitlement_rollback_retry',
            },
          },
        })
      ).resolves.toBeNull();
    } finally {
      await prisma.$executeRawUnsafe(`DROP TRIGGER IF EXISTS ${triggerName}`);
    }

    const retryResponse = await postOneTimeWebhook(event);
    expect(retryResponse.statusCode).toBe(200);
    const retriedPayment = await prisma.payment.findUnique({
      where: { id: payment.id },
    });
    const retriedUser = await prisma.user.findUnique({
      where: { id: testUserId },
    });
    const retriedEvent = await prisma.paymentEvent.findUnique({
      where: { stripeEventId: event.id },
    });
    expect(retriedPayment.status).toBe('succeeded');
    expect(retriedUser).toMatchObject({ planTier: 'pro', role: 'premium' });
    expect(retriedEvent.outcome).toBe('processed');
  }, 20000);

  test.each([
    { initialStatus: 'failed', suffix: 'failed' },
    { initialStatus: 'canceled', suffix: 'canceled' },
  ])(
    'does not resurrect a $initialStatus payment from a success webhook',
    async ({ initialStatus, suffix }) => {
      const paymentIntentId = `pi_terminal_success_${suffix}`;
      const payment = await createLocalPayment({
        status: initialStatus,
        stripePaymentIntentId: paymentIntentId,
      });
      const event = paymentIntentEvent({
        id: `evt_terminal_success_${suffix}`,
        paymentIntentId,
        paymentId: payment.id,
      });

      const response = await postOneTimeWebhook(event);

      expect(response.statusCode).toBe(500);
      await expect(
        prisma.payment.findUnique({ where: { id: payment.id } })
      ).resolves.toMatchObject({ status: initialStatus });
      await expect(
        prisma.paymentEvent.findUnique({ where: { stripeEventId: event.id } })
      ).resolves.toBeNull();
      await expect(
        prisma.user.findUnique({ where: { id: testUserId } })
      ).resolves.toMatchObject({ planTier: null, role: 'student' });
    }
  );

  test('failed payment requires trusted reconciliation and a new success event before entitlement', async () => {
    const paymentIntentId = 'pi_failed_reconcile_success';
    const payment = await createLocalPayment({ stripePaymentIntentId: paymentIntentId });
    const failureEvent = paymentIntentEvent({
      id: 'evt_failed_before_reconcile',
      type: 'payment_intent.payment_failed',
      paymentIntentId,
      paymentId: payment.id,
    });

    expect((await postOneTimeWebhook(failureEvent)).statusCode).toBe(200);
    await expect(
      prisma.payment.findUnique({ where: { id: payment.id } })
    ).resolves.toMatchObject({ status: PAYMENT_STATUSES.FAILED });
    await expect(
      prisma.user.findUnique({ where: { id: testUserId } })
    ).resolves.toMatchObject({ planTier: null, role: 'student' });
    expect(await prisma.subscription.count({ where: { userId: testUserId } })).toBe(0);

    const forbiddenSuccessEvent = paymentIntentEvent({
      id: 'evt_success_while_still_failed',
      paymentIntentId,
      paymentId: payment.id,
    });
    expect((await postOneTimeWebhook(forbiddenSuccessEvent)).statusCode).toBe(500);
    await expect(
      prisma.payment.findUnique({ where: { id: payment.id } })
    ).resolves.toMatchObject({ status: PAYMENT_STATUSES.FAILED });
    await expect(
      prisma.paymentEvent.findUnique({ where: { stripeEventId: forbiddenSuccessEvent.id } })
    ).resolves.toBeNull();

    const reconciliation = await applyTransition(
      prisma,
      payment.id,
      PAYMENT_STATUSES.PENDING,
      {
        retryKind: 'reconcile',
        source: 'system_reconcile',
        actorType: 'system',
        reason: 'Stripe retry was explicitly verified',
      }
    );
    expect(reconciliation).toMatchObject({
      applied: true,
      previousStatus: PAYMENT_STATUSES.FAILED,
      targetStatus: PAYMENT_STATUSES.PENDING,
    });
    await expect(
      prisma.payment.findUnique({ where: { id: payment.id } })
    ).resolves.toMatchObject({ status: PAYMENT_STATUSES.PENDING });
    await expect(
      prisma.user.findUnique({ where: { id: testUserId } })
    ).resolves.toMatchObject({ planTier: null, role: 'student' });
    expect(await prisma.subscription.count({ where: { userId: testUserId } })).toBe(0);

    const retriedSuccessEvent = paymentIntentEvent({
      id: 'evt_success_after_trusted_reconcile',
      paymentIntentId,
      paymentId: payment.id,
    });
    expect((await postOneTimeWebhook(retriedSuccessEvent)).statusCode).toBe(200);
    await expect(
      prisma.payment.findUnique({ where: { id: payment.id } })
    ).resolves.toMatchObject({ status: PAYMENT_STATUSES.SUCCEEDED });
    await expect(
      prisma.user.findUnique({ where: { id: testUserId } })
    ).resolves.toMatchObject({ planTier: 'pro', role: 'premium' });
    expect(await prisma.subscription.count({ where: { userId: testUserId } })).toBe(1);

    expect((await postOneTimeWebhook(retriedSuccessEvent)).statusCode).toBe(200);
    expect(await prisma.subscription.count({ where: { userId: testUserId } })).toBe(1);
  }, 20000);

  test('failure and cancellation events after success are committed as ignored_terminal without regression', async () => {
    const payment = await createLocalPayment({
      stripePaymentIntentId: 'pi_success_then_terminal',
    });
    const successEvent = paymentIntentEvent({
      id: 'evt_success_before_stale_terminal',
      paymentIntentId: payment.stripePaymentIntentId,
      paymentId: payment.id,
    });
    expect((await postOneTimeWebhook(successEvent)).statusCode).toBe(200);

    const failedEvent = paymentIntentEvent({
      id: 'evt_stale_failed_after_success',
      type: 'payment_intent.payment_failed',
      paymentIntentId: payment.stripePaymentIntentId,
      paymentId: payment.id,
    });
    const canceledEvent = paymentIntentEvent({
      id: 'evt_stale_canceled_after_success',
      type: 'payment_intent.canceled',
      paymentIntentId: payment.stripePaymentIntentId,
      paymentId: payment.id,
    });

    expect((await postOneTimeWebhook(failedEvent)).statusCode).toBe(200);
    expect((await postOneTimeWebhook(canceledEvent)).statusCode).toBe(200);
    await expect(
      prisma.payment.findUnique({ where: { id: payment.id } })
    ).resolves.toMatchObject({ status: 'succeeded' });
    const staleEvents = await prisma.paymentEvent.findMany({
      where: { stripeEventId: { in: [failedEvent.id, canceledEvent.id] } },
      orderBy: { stripeEventId: 'asc' },
    });
    expect(staleEvents).toHaveLength(2);
    expect(staleEvents.every((stored) => stored.outcome === 'ignored_terminal')).toBe(true);
    expect(staleEvents.every((stored) => stored.processedAt != null)).toBe(true);
  }, 20000);

  test.each([
    {
      eventType: 'payment_intent.processing',
      expectedStatus: 'processing',
      suffix: 'processing',
    },
    {
      eventType: 'payment_intent.payment_failed',
      expectedStatus: 'failed',
      suffix: 'failed',
    },
    {
      eventType: 'payment_intent.canceled',
      expectedStatus: 'canceled',
      suffix: 'canceled',
    },
  ])(
    '$eventType converges a pending payment to $expectedStatus',
    async ({ eventType, expectedStatus, suffix }) => {
      const paymentIntentId = `pi_pending_${suffix}`;
      const payment = await createLocalPayment({
        stripePaymentIntentId: paymentIntentId,
      });
      const event = paymentIntentEvent({
        id: `evt_pending_${suffix}`,
        type: eventType,
        paymentIntentId,
        paymentId: payment.id,
      });

      const response = await postOneTimeWebhook(event);

      expect(response.statusCode).toBe(200);
      await expect(
        prisma.payment.findUnique({ where: { id: payment.id } })
      ).resolves.toMatchObject({ status: expectedStatus });
      const storedEvent = await prisma.paymentEvent.findUnique({
        where: { stripeEventId: event.id },
      });
      expect(storedEvent.outcome).toBe('processed');
      expect(storedEvent.processedAt).not.toBeNull();
    }
  );

  test('unsupported event is finalized as ignored without resolving or mutating a Payment', async () => {
    const payment = await createLocalPayment({
      stripePaymentIntentId: null,
      externalId: null,
    });
    const event = paymentIntentEvent({
      id: 'evt_unsupported_one_time_route',
      type: 'charge.succeeded',
      paymentIntentId: 'pi_unsupported_should_not_attach',
      paymentId: payment.id,
    });

    const response = await postOneTimeWebhook(event);

    expect(response.statusCode).toBe(200);
    await expect(
      prisma.payment.findUnique({ where: { id: payment.id } })
    ).resolves.toMatchObject({
      status: 'pending',
      stripePaymentIntentId: null,
    });
    const storedEvent = await prisma.paymentEvent.findUnique({
      where: { stripeEventId: event.id },
    });
    expect(storedEvent).toMatchObject({ paymentId: null, outcome: 'ignored' });
    expect(storedEvent.processedAt).not.toBeNull();
  }, 20000);

  test('conflicting PI lookup and metadata identity rolls back and returns 500', async () => {
    const byStripe = await createLocalPayment({
      stripePaymentIntentId: 'pi_identity_conflict',
      idempotencyKey: `identity-stripe-${Date.now()}`,
    });
    const byMetadata = await createLocalPayment({
      stripePaymentIntentId: null,
      idempotencyKey: `identity-metadata-${Date.now()}`,
    });
    const event = paymentIntentEvent({
      id: 'evt_payment_identity_conflict',
      paymentIntentId: byStripe.stripePaymentIntentId,
      paymentId: byMetadata.id,
    });

    const response = await postOneTimeWebhook(event);

    expect(response.statusCode).toBe(500);
    const payments = await prisma.payment.findMany({
      where: { id: { in: [byStripe.id, byMetadata.id] } },
    });
    expect(payments.every((payment) => payment.status === 'pending')).toBe(true);
    await expect(
      prisma.paymentEvent.findUnique({ where: { stripeEventId: event.id } })
    ).resolves.toBeNull();
  }, 20000);

  test('a supported event with no matching Payment returns 500 and commits no claim', async () => {
    const event = paymentIntentEvent({
      id: 'evt_missing_local_payment',
      paymentIntentId: 'pi_missing_local_payment',
      paymentId: 2147483647,
    });

    const response = await postOneTimeWebhook(event);

    expect(response.statusCode).toBe(500);
    await expect(
      prisma.paymentEvent.findUnique({ where: { stripeEventId: event.id } })
    ).resolves.toBeNull();
  }, 20000);

  test('returns 400 and writes nothing for an invalid signature when the webhook secret is configured', async () => {
    const previousSecret = process.env.STRIPE_WEBHOOK_SECRET;
    const event = paymentIntentEvent({
      id: 'evt_invalid_one_time_signature',
      paymentIntentId: 'pi_invalid_one_time_signature',
      paymentId: 2147483647,
    });
    const timestamp = Math.floor(Date.now() / 1000);
    const invalidSignature = crypto
      .createHmac('sha256', 'a-different-secret')
      .update(`${timestamp}.${JSON.stringify(event)}`)
      .digest('hex');

    process.env.STRIPE_WEBHOOK_SECRET = 'whsec_phase2b_signature';
    try {
      const response = await request(app)
        .post('/api/webhooks/stripe')
        .set('Content-Type', 'application/json')
        .set('stripe-signature', `t=${timestamp},v1=${invalidSignature}`)
        .send(event);

      expect(response.statusCode).toBe(400);
      await expect(
        prisma.paymentEvent.findUnique({ where: { stripeEventId: event.id } })
      ).resolves.toBeNull();
    } finally {
      if (previousSecret === undefined) delete process.env.STRIPE_WEBHOOK_SECRET;
      else process.env.STRIPE_WEBHOOK_SECRET = previousSecret;
    }
  }, 20000);
});
