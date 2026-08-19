import request from 'supertest';
import Stripe from 'stripe';
import app from '../app.js';
import { setupTestDb } from './helpers/db.setup.js';
import prisma from '../utils/prismaClient.js';

setupTestDb();

const stripe = new Stripe('sk_test_dummy_key_for_signature_tests');
const WEBHOOK_SECRET = 'whsec_test_secret_for_payments_webhook';

const sign = (payloadString, secret = WEBHOOK_SECRET) =>
  stripe.webhooks.generateTestHeaderString({ payload: payloadString, secret });

const postEvent = (event, { signature, omitSignature = false } = {}) => {
  const payloadString = JSON.stringify(event);
  const header = omitSignature ? undefined : signature || sign(payloadString);
  const req = request(app)
    .post('/api/payments/webhook')
    .set('Content-Type', 'application/json');
  if (header) req.set('stripe-signature', header);
  return req.send(payloadString);
};

describe('POST /api/payments/webhook', () => {
  let previousEnv;
  let testUserId;

  beforeEach(async () => {
    previousEnv = {
      STRIPE_WEBHOOK_SECRET: process.env.STRIPE_WEBHOOK_SECRET,
      STRIPE_PRICE_BASICO: process.env.STRIPE_PRICE_BASICO,
      STRIPE_PRICE_PRO: process.env.STRIPE_PRICE_PRO,
      STRIPE_PRICE_MASTER: process.env.STRIPE_PRICE_MASTER,
    };
    process.env.STRIPE_WEBHOOK_SECRET = WEBHOOK_SECRET;
    process.env.STRIPE_PRICE_BASICO = 'price_test_basico';
    process.env.STRIPE_PRICE_PRO = 'price_test_pro';
    process.env.STRIPE_PRICE_MASTER = 'price_test_master';

    const user = await prisma.user.create({
      data: {
        email: `test-webhook-${Date.now()}-${Math.random().toString(36).slice(2)}@example.com`,
        passwordHash: 'hashed-password',
        name: 'Webhook User',
      },
    });
    testUserId = user.id;
  });

  afterEach(async () => {
    await prisma.auditLog.deleteMany({});
    await prisma.paymentEvent.deleteMany({});
    await prisma.subscription.deleteMany({});
    await prisma.payment.deleteMany({});
    // User cleanup (excluding the fixed admin account) is handled by setupTestDb()'s afterEach.

    for (const [key, value] of Object.entries(previousEnv)) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  });

  afterAll(async () => {
    await prisma.$disconnect();
  });

  describe('signature verification', () => {
    test('missing stripe-signature header returns 400 and processes nothing', async () => {
      const event = {
        id: 'evt_missing_sig',
        type: 'customer.subscription.deleted',
        data: { object: { id: 'sub_missing_sig' } },
      };

      const res = await postEvent(event, { omitSignature: true });

      expect(res.statusCode).toBe(400);
      const stored = await prisma.paymentEvent.findUnique({ where: { stripeEventId: event.id } });
      expect(stored).toBeNull();
    });

    test('invalid signature returns 400 and processes nothing', async () => {
      const event = {
        id: 'evt_bad_sig',
        type: 'customer.subscription.deleted',
        data: { object: { id: 'sub_bad_sig' } },
      };

      const res = await postEvent(event, { signature: sign(JSON.stringify(event), 'whsec_totally_wrong_secret') });

      expect(res.statusCode).toBe(400);
      const stored = await prisma.paymentEvent.findUnique({ where: { stripeEventId: event.id } });
      expect(stored).toBeNull();
    });
  });

  describe('checkout.session.completed', () => {
    test('activates the subscription and upgrades the user', async () => {
      const payment = await prisma.payment.create({
        data: {
          userId: testUserId,
          amount: 2499,
          currency: 'usd',
          planTier: 'pro',
          status: 'pending',
          provider: 'stripe',
          idempotencyKey: `checkout-${Date.now()}`,
          stripeCheckoutSessionId: 'cs_test_completed_1',
        },
      });

      const event = {
        id: 'evt_checkout_completed_1',
        type: 'checkout.session.completed',
        data: {
          object: {
            id: 'cs_test_completed_1',
            mode: 'subscription',
            customer: 'cus_test_1',
            subscription: 'sub_test_1',
            client_reference_id: String(testUserId),
            metadata: { paymentId: String(payment.id), planTier: 'pro' },
          },
        },
      };

      const res = await postEvent(event);

      expect(res.statusCode).toBe(200);
      expect(res.body.outcome).toBe('processed');

      const updatedPayment = await prisma.payment.findUnique({ where: { id: payment.id } });
      expect(updatedPayment.status).toBe('succeeded');

      const subscription = await prisma.subscription.findUnique({
        where: { provider_externalId: { provider: 'stripe', externalId: 'sub_test_1' } },
      });
      expect(subscription).not.toBeNull();
      expect(subscription.status).toBe('active');
      expect(subscription.planTier).toBe('pro');

      const user = await prisma.user.findUnique({ where: { id: testUserId } });
      expect(user.planTier).toBe('pro');
      expect(user.role).toBe('premium');
      expect(user.stripeCustomerId).toBe('cus_test_1');

      const auditEntries = await prisma.auditLog.findMany({ where: { action: 'checkout.session.completed' } });
      expect(auditEntries).toHaveLength(1);
    });

    test('converges processing to succeeded through metadata before Checkout id attachment', async () => {
      const payment = await prisma.payment.create({
        data: {
          userId: testUserId,
          amount: 4999,
          currency: 'usd',
          planTier: 'master',
          status: 'processing',
          provider: 'stripe',
          idempotencyKey: `checkout-processing-${Date.now()}`,
        },
      });
      const event = {
        id: 'evt_checkout_processing_metadata',
        type: 'checkout.session.completed',
        data: {
          object: {
            id: 'cs_not_attached_locally',
            mode: 'subscription',
            customer: 'cus_processing_metadata',
            subscription: 'sub_processing_metadata',
            client_reference_id: String(testUserId),
            metadata: { paymentId: String(payment.id), planTier: 'master' },
          },
        },
      };

      const res = await postEvent(event);

      expect(res.statusCode).toBe(200);
      expect(res.body.outcome).toBe('processed');
      const updatedPayment = await prisma.payment.findUnique({ where: { id: payment.id } });
      expect(updatedPayment).toMatchObject({
        status: 'succeeded',
        stripeCheckoutSessionId: null,
        externalId: 'sub_processing_metadata',
      });
      const user = await prisma.user.findUnique({ where: { id: testUserId } });
      expect(user).toMatchObject({ planTier: 'master', role: 'premium' });
    });

    test('a distinct event for succeeded Payment is a no-op with no entitlement rewrite', async () => {
      await prisma.user.update({
        where: { id: testUserId },
        data: { planTier: 'basico', role: 'student' },
      });
      const payment = await prisma.payment.create({
        data: {
          userId: testUserId,
          amount: 2499,
          currency: 'usd',
          planTier: 'pro',
          status: 'succeeded',
          provider: 'stripe',
          idempotencyKey: `checkout-already-succeeded-${Date.now()}`,
        },
      });
      const event = {
        id: 'evt_checkout_distinct_already_succeeded',
        type: 'checkout.session.completed',
        data: {
          object: {
            id: 'cs_distinct_already_succeeded',
            mode: 'subscription',
            customer: 'cus_should_not_attach',
            subscription: 'sub_should_not_create',
            metadata: { paymentId: String(payment.id), planTier: 'pro' },
          },
        },
      };

      const res = await postEvent(event);

      expect(res.statusCode).toBe(200);
      expect(res.body.outcome).toBe('already_succeeded');
      const user = await prisma.user.findUnique({ where: { id: testUserId } });
      expect(user).toMatchObject({
        planTier: 'basico',
        role: 'student',
        stripeCustomerId: null,
      });
      expect(
        await prisma.subscription.findUnique({
          where: {
            provider_externalId: {
              provider: 'stripe',
              externalId: 'sub_should_not_create',
            },
          },
        })
      ).toBeNull();
    });

    test.each(['failed', 'canceled'])(
      'rejects success for terminal %s Payment and rolls back the event claim',
      async (status) => {
        const payment = await prisma.payment.create({
          data: {
            userId: testUserId,
            amount: 999,
            currency: 'usd',
            planTier: 'basico',
            status,
            provider: 'stripe',
            idempotencyKey: `checkout-terminal-${status}-${Date.now()}`,
          },
        });
        const event = {
          id: `evt_checkout_terminal_${status}`,
          type: 'checkout.session.completed',
          data: {
            object: {
              id: `cs_checkout_terminal_${status}`,
              mode: 'subscription',
              customer: `cus_checkout_terminal_${status}`,
              subscription: `sub_checkout_terminal_${status}`,
              metadata: { paymentId: String(payment.id), planTier: 'basico' },
            },
          },
        };

        const res = await postEvent(event);

        expect(res.statusCode).toBe(500);
        const unchanged = await prisma.payment.findUnique({ where: { id: payment.id } });
        expect(unchanged.status).toBe(status);
        expect(
          await prisma.paymentEvent.findUnique({ where: { stripeEventId: event.id } })
        ).toBeNull();
        const user = await prisma.user.findUnique({ where: { id: testUserId } });
        expect(user).toMatchObject({ planTier: null, role: 'student' });
      }
    );

    test.each(['completed', 'processed'])(
      'treats legacy %s Payment as read-only already-successful',
      async (status) => {
        const payment = await prisma.payment.create({
          data: {
            userId: testUserId,
            amount: 999,
            currency: 'usd',
            planTier: 'basico',
            status,
            provider: 'stripe',
            idempotencyKey: `checkout-legacy-${status}-${Date.now()}`,
          },
        });
        const event = {
          id: `evt_checkout_legacy_${status}`,
          type: 'checkout.session.completed',
          data: {
            object: {
              id: `cs_checkout_legacy_${status}`,
              mode: 'subscription',
              subscription: `sub_checkout_legacy_${status}`,
              metadata: { paymentId: String(payment.id), planTier: 'basico' },
            },
          },
        };

        const res = await postEvent(event);

        expect(res.statusCode).toBe(200);
        expect(res.body.outcome).toBe('legacy_already_succeeded');
        const unchanged = await prisma.payment.findUnique({ where: { id: payment.id } });
        expect(unchanged.status).toBe(status);
        const user = await prisma.user.findUnique({ where: { id: testUserId } });
        expect(user).toMatchObject({ planTier: null, role: 'student' });
      }
    );

    test('duplicate Checkout event does not reapply entitlement', async () => {
      const payment = await prisma.payment.create({
        data: {
          userId: testUserId,
          amount: 2499,
          currency: 'usd',
          planTier: 'pro',
          status: 'pending',
          provider: 'stripe',
          idempotencyKey: `checkout-duplicate-success-${Date.now()}`,
        },
      });
      const event = {
        id: 'evt_checkout_duplicate_success',
        type: 'checkout.session.completed',
        data: {
          object: {
            id: 'cs_checkout_duplicate_success',
            mode: 'subscription',
            subscription: 'sub_checkout_duplicate_success',
            metadata: { paymentId: String(payment.id), planTier: 'pro' },
          },
        },
      };

      expect((await postEvent(event)).body.outcome).toBe('processed');
      await prisma.user.update({
        where: { id: testUserId },
        data: { planTier: null, role: 'student' },
      });

      const duplicate = await postEvent(event);

      expect(duplicate.statusCode).toBe(200);
      expect(duplicate.body.outcome).toBe('duplicate');
      const user = await prisma.user.findUnique({ where: { id: testUserId } });
      expect(user).toMatchObject({ planTier: null, role: 'student' });
      expect(
        await prisma.auditLog.findMany({ where: { action: 'checkout.session.completed' } })
      ).toHaveLength(1);
    });

    test('does not activate entitlement without a resolved local Payment', async () => {
      const event = {
        id: 'evt_checkout_missing_payment',
        type: 'checkout.session.completed',
        data: {
          object: {
            id: 'cs_checkout_missing_payment',
            mode: 'subscription',
            subscription: 'sub_checkout_missing_payment',
            client_reference_id: String(testUserId),
            metadata: { planTier: 'pro' },
          },
        },
      };

      const res = await postEvent(event);

      expect(res.statusCode).toBe(500);
      const user = await prisma.user.findUnique({ where: { id: testUserId } });
      expect(user).toMatchObject({ planTier: null, role: 'student' });
      expect(
        await prisma.paymentEvent.findUnique({ where: { stripeEventId: event.id } })
      ).toBeNull();
    });
  });

  describe('subscription lifecycle events (after an active subscription exists)', () => {
    let subscriptionExternalId;

    beforeEach(async () => {
      subscriptionExternalId = `sub_test_${Date.now()}`;
      await prisma.user.update({
        where: { id: testUserId },
        data: { stripeCustomerId: 'cus_test_lifecycle', planTier: 'pro', role: 'premium' },
      });
      await prisma.subscription.create({
        data: {
          userId: testUserId,
          planTier: 'pro',
          status: 'active',
          provider: 'stripe',
          externalId: subscriptionExternalId,
          currentPeriodStart: new Date(),
          currentPeriodEnd: new Date(Date.now() + 30 * 24 * 60 * 60 * 1000),
        },
      });
    });

    test('invoice.paid keeps the subscription active and extends the period', async () => {
      const periodStart = Math.floor(Date.now() / 1000);
      const periodEnd = periodStart + 30 * 24 * 60 * 60;
      const event = {
        id: 'evt_invoice_paid_1',
        type: 'invoice.paid',
        data: {
          object: { id: 'in_test_1', subscription: subscriptionExternalId, period_start: periodStart, period_end: periodEnd },
        },
      };

      const res = await postEvent(event);

      expect(res.statusCode).toBe(200);
      expect(res.body.outcome).toBe('processed');

      const subscription = await prisma.subscription.findUnique({
        where: { provider_externalId: { provider: 'stripe', externalId: subscriptionExternalId } },
      });
      expect(subscription.status).toBe('active');
      expect(Math.floor(subscription.currentPeriodEnd.getTime() / 1000)).toBe(periodEnd);

      const user = await prisma.user.findUnique({ where: { id: testUserId } });
      expect(user.role).toBe('premium');

      const auditEntries = await prisma.auditLog.findMany({ where: { action: 'invoice.paid' } });
      expect(auditEntries).toHaveLength(1);
    });

    test('invoice.payment_failed marks the subscription past_due without downgrading the user', async () => {
      const event = {
        id: 'evt_invoice_failed_1',
        type: 'invoice.payment_failed',
        data: { object: { id: 'in_test_2', subscription: subscriptionExternalId } },
      };

      const res = await postEvent(event);

      expect(res.statusCode).toBe(200);
      expect(res.body.outcome).toBe('processed');

      const subscription = await prisma.subscription.findUnique({
        where: { provider_externalId: { provider: 'stripe', externalId: subscriptionExternalId } },
      });
      expect(subscription.status).toBe('past_due');

      const user = await prisma.user.findUnique({ where: { id: testUserId } });
      expect(user.planTier).toBe('pro');
      expect(user.role).toBe('premium');
    });

    test('customer.subscription.updated syncs plan tier and period from Stripe', async () => {
      const periodStart = Math.floor(Date.now() / 1000);
      const periodEnd = periodStart + 30 * 24 * 60 * 60;
      const event = {
        id: 'evt_sub_updated_1',
        type: 'customer.subscription.updated',
        data: {
          object: {
            id: subscriptionExternalId,
            customer: 'cus_test_lifecycle',
            status: 'active',
            items: { data: [{ price: { id: 'price_test_master' } }] },
            current_period_start: periodStart,
            current_period_end: periodEnd,
          },
        },
      };

      const res = await postEvent(event);

      expect(res.statusCode).toBe(200);
      expect(res.body.outcome).toBe('processed');

      const subscription = await prisma.subscription.findUnique({
        where: { provider_externalId: { provider: 'stripe', externalId: subscriptionExternalId } },
      });
      expect(subscription.planTier).toBe('master');
      expect(subscription.status).toBe('active');

      const user = await prisma.user.findUnique({ where: { id: testUserId } });
      expect(user.planTier).toBe('master');
      expect(user.role).toBe('premium');
    });

    test('customer.subscription.deleted cancels the subscription and downgrades the user', async () => {
      const event = {
        id: 'evt_sub_deleted_1',
        type: 'customer.subscription.deleted',
        data: { object: { id: subscriptionExternalId, customer: 'cus_test_lifecycle', status: 'canceled' } },
      };

      const res = await postEvent(event);

      expect(res.statusCode).toBe(200);
      expect(res.body.outcome).toBe('processed');

      const subscription = await prisma.subscription.findUnique({
        where: { provider_externalId: { provider: 'stripe', externalId: subscriptionExternalId } },
      });
      expect(subscription.status).toBe('canceled');

      const user = await prisma.user.findUnique({ where: { id: testUserId } });
      expect(user.planTier).toBeNull();
      expect(user.role).toBe('student');

      const auditEntries = await prisma.auditLog.findMany({ where: { action: 'customer.subscription.deleted' } });
      expect(auditEntries).toHaveLength(1);
    });
  });

  describe('idempotency', () => {
    test('the same event delivered twice only applies its effect once', async () => {
      const subscriptionExternalId = `sub_test_dup_${Date.now()}`;
      await prisma.user.update({
        where: { id: testUserId },
        data: { stripeCustomerId: 'cus_test_dup' },
      });
      await prisma.subscription.create({
        data: {
          userId: testUserId,
          planTier: 'pro',
          status: 'active',
          provider: 'stripe',
          externalId: subscriptionExternalId,
          currentPeriodStart: new Date(),
          currentPeriodEnd: new Date(Date.now() + 30 * 24 * 60 * 60 * 1000),
        },
      });

      const event = {
        id: 'evt_duplicate_delivery_1',
        type: 'customer.subscription.deleted',
        data: { object: { id: subscriptionExternalId, customer: 'cus_test_dup', status: 'canceled' } },
      };

      const res1 = await postEvent(event);
      expect(res1.statusCode).toBe(200);
      expect(res1.body.outcome).toBe('processed');

      const res2 = await postEvent(event);
      expect(res2.statusCode).toBe(200);
      expect(res2.body.outcome).toBe('duplicate');

      const events = await prisma.paymentEvent.findMany({ where: { stripeEventId: event.id } });
      expect(events).toHaveLength(1);

      const auditEntries = await prisma.auditLog.findMany({ where: { action: 'customer.subscription.deleted' } });
      expect(auditEntries).toHaveLength(1);
    });
  });

  describe('transactional rollback', () => {
    test('a failure mid-transaction leaves no partial state behind', async () => {
      const conflictingUser = await prisma.user.create({
        data: {
          email: `test-webhook-conflict-${Date.now()}@example.com`,
          passwordHash: 'hashed-password',
          name: 'Conflicting Customer',
          stripeCustomerId: 'cus_conflict_taken',
        },
      });

      const payment = await prisma.payment.create({
        data: {
          userId: testUserId,
          amount: 999,
          currency: 'usd',
          planTier: 'basico',
          status: 'pending',
          provider: 'stripe',
          idempotencyKey: `checkout-rollback-${Date.now()}`,
          stripeCheckoutSessionId: 'cs_test_rollback_1',
        },
      });

      // session.customer collides with another user's stripeCustomerId (unique
      // constraint), forcing a P2002 partway through the transaction.
      const event = {
        id: 'evt_checkout_rollback_1',
        type: 'checkout.session.completed',
        data: {
          object: {
            id: 'cs_test_rollback_1',
            mode: 'subscription',
            customer: 'cus_conflict_taken',
            subscription: 'sub_test_rollback_1',
            client_reference_id: String(testUserId),
            metadata: { paymentId: String(payment.id), planTier: 'basico' },
          },
        },
      };

      const res = await postEvent(event);

      expect(res.statusCode).toBe(500);

      const storedEvent = await prisma.paymentEvent.findUnique({ where: { stripeEventId: event.id } });
      expect(storedEvent).toBeNull();

      const unchangedPayment = await prisma.payment.findUnique({ where: { id: payment.id } });
      expect(unchangedPayment.status).toBe('pending');

      const subscription = await prisma.subscription.findUnique({
        where: { provider_externalId: { provider: 'stripe', externalId: 'sub_test_rollback_1' } },
      });
      expect(subscription).toBeNull();

      const user = await prisma.user.findUnique({ where: { id: testUserId } });
      expect(user.planTier).toBeNull();
      expect(user.stripeCustomerId).toBeNull();

      const auditEntries = await prisma.auditLog.findMany({ where: { action: 'checkout.session.completed' } });
      expect(auditEntries).toHaveLength(0);

      await prisma.user.delete({ where: { id: conflictingUser.id } });
    });
  });
});
