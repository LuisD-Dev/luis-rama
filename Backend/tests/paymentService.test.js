import { setupTestDb } from './helpers/db.setup.js';
import prisma from '../utils/prismaClient.js';
import {
  createPaymentIntent,
  markPaymentCompleted,
  recordPaymentEvent,
  InvalidPlanError,
  PaymentNotFoundError,
} from '../services/paymentService.js';

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

  test('markPaymentCompleted sets status to completed', async () => {
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

    expect(updated.status).toBe('completed');
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

  test('second markPaymentCompleted is idempotent', async () => {
    const payment = await createPaymentIntent({
      userId,
      planTier: 'pro',
      amount: 2499,
      idempotencyKey: `idem-complete-${Date.now()}`,
    });

    const first = await markPaymentCompleted({
      paymentId: payment.id,
      subscriptionExternalId: `sub_idem_${payment.id}`,
    });
    const second = await markPaymentCompleted({
      paymentId: payment.id,
      subscriptionExternalId: `sub_idem_${payment.id}`,
    });

    expect(first.alreadyCompleted).toBe(false);
    expect(second.alreadyCompleted).toBe(true);
    expect(second.payment.status).toBe('completed');

    const payments = await prisma.payment.findMany({ where: { id: payment.id } });
    expect(payments).toHaveLength(1);

    const completedEvents = await prisma.paymentEvent.findMany({
      where: { type: 'payment.completed', paymentId: payment.id },
    });
    expect(completedEvents).toHaveLength(1);
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
});
