import request from 'supertest';
import Stripe from 'stripe';
import app from '../app.js';
import { setupTestDb } from './helpers/db.setup.js';
import prisma from '../utils/prismaClient.js';

setupTestDb();

const stripe = new Stripe('sk_test_dummy_key_for_signature_tests');
const WEBHOOK_SECRET = 'whsec_test_secret_for_payments_webhook';
const CANONICAL_WEBHOOK_PATH = '/api/webhooks/stripe';
const WEBHOOK_ALIAS_PATH = '/api/payments/webhook';

const sign = (payloadString, secret = WEBHOOK_SECRET, timestamp) =>
  stripe.webhooks.generateTestHeaderString({
    payload: payloadString,
    secret,
    ...(timestamp === undefined ? {} : { timestamp }),
  });

const postRawPayload = (
  payloadString,
  {
    path = CANONICAL_WEBHOOK_PATH,
    signature,
    omitSignature = false,
    secret = WEBHOOK_SECRET,
    timestamp,
  } = {}
) => {
  const header = omitSignature
    ? undefined
    : signature || sign(payloadString, secret, timestamp);
  const req = request(app)
    .post(path)
    .set('Content-Type', 'application/json');
  if (header) req.set('stripe-signature', header);
  return req.send(payloadString);
};

const postEvent = (event, options) => {
  const payloadString = JSON.stringify(event);
  return postRawPayload(payloadString, options);
};

describe('Stripe webhook (canonical /api/webhooks/stripe)', () => {
  let previousEnv;
  let testUserId;

  beforeEach(async () => {
    previousEnv = {
      NODE_ENV: process.env.NODE_ENV,
      STRIPE_WEBHOOK_SECRET: process.env.STRIPE_WEBHOOK_SECRET,
      STRIPE_WEBHOOK_TOLERANCE_SEC:
        process.env.STRIPE_WEBHOOK_TOLERANCE_SEC,
      VERCEL: process.env.VERCEL,
      NODEJS_HELPERS: process.env.NODEJS_HELPERS,
      STRIPE_PRICE_BASICO: process.env.STRIPE_PRICE_BASICO,
      STRIPE_PRICE_PRO: process.env.STRIPE_PRICE_PRO,
      STRIPE_PRICE_MASTER: process.env.STRIPE_PRICE_MASTER,
    };
    process.env.NODE_ENV = 'test';
    process.env.STRIPE_WEBHOOK_SECRET = WEBHOOK_SECRET;
    delete process.env.STRIPE_WEBHOOK_TOLERANCE_SEC;
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
    test('missing runtime webhook configuration returns 503 without dispatching', async () => {
      const event = {
        id: 'evt_missing_runtime_secret',
        type: 'test.unhandled',
        data: { object: {} },
      };
      delete process.env.STRIPE_WEBHOOK_SECRET;

      const res = await postEvent(event);

      expect(res.statusCode).toBe(503);
      expect(res.body).toEqual({
        error: 'Stripe webhook verification unavailable',
      });
      await expect(
        prisma.paymentEvent.findUnique({
          where: { stripeEventId: event.id },
        })
      ).resolves.toBeNull();
    });

    test('a valid SDK-signed payload is accepted by the canonical endpoint', async () => {
      const event = {
        id: 'evt_valid_sdk_signature',
        type: 'test.unhandled',
        data: { object: {} },
      };

      const res = await postEvent(event);

      expect(res.statusCode).toBe(200);
      expect(res.body).toEqual({ received: true, outcome: 'ignored' });
      await expect(
        prisma.paymentEvent.findUnique({
          where: { stripeEventId: event.id },
        })
      ).resolves.toMatchObject({ outcome: 'ignored' });
    });

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

      const res = await postEvent(event, {
        secret: 'whsec_totally_wrong_secret',
      });

      expect(res.statusCode).toBe(400);
      const stored = await prisma.paymentEvent.findUnique({ where: { stripeEventId: event.id } });
      expect(stored).toBeNull();
    });

    test('a body changed after signing returns 400 and processes nothing', async () => {
      const signedEvent = {
        id: 'evt_body_before_tamper',
        type: 'test.unhandled',
        data: { object: { value: 'original' } },
      };
      const tamperedEvent = {
        ...signedEvent,
        id: 'evt_body_after_tamper',
        data: { object: { value: 'tampered' } },
      };
      const signedPayload = JSON.stringify(signedEvent);
      const tamperedPayload = JSON.stringify(tamperedEvent);

      const res = await postRawPayload(tamperedPayload, {
        signature: sign(signedPayload),
      });

      expect(res.statusCode).toBe(400);
      expect(
        await prisma.paymentEvent.findMany({
          where: {
            stripeEventId: {
              in: [signedEvent.id, tamperedEvent.id],
            },
          },
        })
      ).toHaveLength(0);
    });

    test('an expired timestamp returns 400 using the configured tolerance', async () => {
      const event = {
        id: 'evt_expired_signature_timestamp',
        type: 'test.unhandled',
        data: { object: {} },
      };
      const payloadString = JSON.stringify(event);
      const timestamp = Math.floor(Date.now() / 1000) - 30;
      process.env.STRIPE_WEBHOOK_TOLERANCE_SEC = '5';

      const res = await postRawPayload(payloadString, { timestamp });

      expect(res.statusCode).toBe(400);
      await expect(
        prisma.paymentEvent.findUnique({
          where: { stripeEventId: event.id },
        })
      ).resolves.toBeNull();
    });

    test('signed malformed JSON returns 400 before dispatch', async () => {
      const malformedPayload = '{"id":"evt_signed_malformed","type":';

      const res = await postRawPayload(malformedPayload);

      expect(res.statusCode).toBe(400);
      await expect(
        prisma.paymentEvent.findUnique({
          where: { stripeEventId: 'evt_signed_malformed' },
        })
      ).resolves.toBeNull();
    });

    test('the app preserves non-canonical JSON bytes for signature verification', async () => {
      const payloadString = [
        '{',
        '  "type" : "test.unhandled",',
        '  "data" : { "object" : { "spaced" : true } },',
        '  "id" : "evt_noncanonical_raw_body"',
        '}',
      ].join('\n');

      const res = await postRawPayload(payloadString);

      expect(res.statusCode).toBe(200);
      expect(res.body).toEqual({ received: true, outcome: 'ignored' });
      await expect(
        prisma.paymentEvent.findUnique({
          where: { stripeEventId: 'evt_noncanonical_raw_body' },
        })
      ).resolves.toMatchObject({ outcome: 'ignored' });
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
    test('both webhook paths bypass the generic IP rate limiter', async () => {
      const event = {
        id: 'evt_webhook_rate_limit_bypass',
        type: 'test.unhandled',
        data: { object: {} },
      };
      process.env.NODE_ENV = 'production';
      process.env.VERCEL = '1';
      process.env.NODEJS_HELPERS = '0';

      const responses = [];
      for (let delivery = 0; delivery < 101; delivery += 1) {
        responses.push(
          await postEvent(event, {
            path:
              delivery % 2 === 0
                ? CANONICAL_WEBHOOK_PATH
                : WEBHOOK_ALIAS_PATH,
          })
        );
      }

      expect(responses.every(({ statusCode }) => statusCode === 200)).toBe(true);
      expect(responses[0].body.outcome).toBe('ignored');
      expect(
        responses.slice(1).every(({ body }) => body.outcome === 'duplicate')
      ).toBe(true);
      await expect(
        prisma.paymentEvent.findMany({
          where: { stripeEventId: event.id },
        })
      ).resolves.toHaveLength(1);
    });

    test('canonical endpoint and thin alias share one dispatcher and event claim', async () => {
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
      expect(res1.body).toEqual({ received: true, outcome: 'processed' });

      const res2 = await postEvent(event, { path: WEBHOOK_ALIAS_PATH });
      expect(res2.statusCode).toBe(200);
      expect(res2.body).toEqual({ received: true, outcome: 'duplicate' });

      const events = await prisma.paymentEvent.findMany({ where: { stripeEventId: event.id } });
      expect(events).toHaveLength(1);

      const auditEntries = await prisma.auditLog.findMany({ where: { action: 'customer.subscription.deleted' } });
      expect(auditEntries).toHaveLength(1);
    });
  });

  describe('transactional rollback', () => {
    test('a verified retryable failure returns 500, rolls back, and succeeds on retry', async () => {
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

      const retry = await postEvent(event);

      expect(retry.statusCode).toBe(200);
      expect(retry.body).toEqual({ received: true, outcome: 'processed' });
      await expect(
        prisma.paymentEvent.findUnique({
          where: { stripeEventId: event.id },
        })
      ).resolves.toMatchObject({ outcome: 'processed' });
      await expect(
        prisma.payment.findUnique({ where: { id: payment.id } })
      ).resolves.toMatchObject({ status: 'succeeded' });
      await expect(
        prisma.subscription.findUnique({
          where: {
            provider_externalId: {
              provider: 'stripe',
              externalId: 'sub_test_rollback_1',
            },
          },
        })
      ).resolves.toMatchObject({ status: 'active', planTier: 'basico' });
      await expect(
        prisma.user.findUnique({ where: { id: testUserId } })
      ).resolves.toMatchObject({
        stripeCustomerId: 'cus_conflict_taken',
        planTier: 'basico',
        role: 'premium',
      });
    });
  });
});
