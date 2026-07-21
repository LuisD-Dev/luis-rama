import crypto from 'crypto';
import prisma from '../utils/prismaClient.js';
import https from 'https';

const STRIPE_API_BASE = 'api.stripe.com';

const PLAN_AMOUNTS = { basico: 999, pro: 2499, master: 4999 };

const PRICE_ENV_BY_PLAN = {
  basico: 'STRIPE_PRICE_BASICO',
  pro: 'STRIPE_PRICE_PRO',
  master: 'STRIPE_PRICE_MASTER',
};

export class PaymentServiceError extends Error {
  constructor(message, { statusCode = 502, clientMessage } = {}) {
    super(message);
    this.name = 'PaymentServiceError';
    this.statusCode = statusCode;
    this.clientMessage = clientMessage || message;
  }
}

const getStripeSecret = () => process.env.STRIPE_SECRET_KEY || '';

const stripeRequest = ({ path, method = 'POST', body, idempotencyKey }) => new Promise((resolve, reject) => {
  const data = new URLSearchParams(body).toString();
  const stripeSecret = getStripeSecret();
  const options = {
    hostname: STRIPE_API_BASE,
    path,
    method,
    headers: {
      'Authorization': `Bearer ${stripeSecret}`,
      'Content-Type': 'application/x-www-form-urlencoded',
      'Content-Length': Buffer.byteLength(data),
      ...(idempotencyKey ? { 'Idempotency-Key': idempotencyKey } : {}),
    },
  };

  const req = https.request(options, (res) => {
    let raw = '';
    res.setEncoding('utf8');
    res.on('data', (chunk) => { raw += chunk; });
    res.on('end', () => {
      try {
        const parsed = JSON.parse(raw);
        if (res.statusCode && res.statusCode >= 200 && res.statusCode < 300) {
          resolve(parsed);
        } else {
          reject(parsed);
        }
      } catch (err) {
        reject(err);
      }
    });
  });

  req.on('error', (err) => reject(err));
  req.write(data);
  req.end();
});

const resolvePriceId = (plan) => {
  const envKey = PRICE_ENV_BY_PLAN[plan];
  if (!envKey) return null;
  return process.env[envKey] || null;
};

export async function createOrReusePayment({ userId, paymentMethodId, planTier, idempotencyKey }) {
  if (!idempotencyKey) throw new Error('idempotencyKey required');

  const amount = PLAN_AMOUNTS[planTier] ?? 0;
  const stripeSecret = getStripeSecret();

  return prisma.$transaction(async (tx) => {
    const existing = await tx.payment.findUnique({ where: { idempotencyKey } }).catch(() => null);
    if (existing) return existing;

    const payment = await tx.payment.create({
      data: {
        userId,
        amount,
        currency: 'usd',
        planTier,
        paymentMethodId,
        idempotencyKey,
        status: 'pending',
      },
    });

    // Create PaymentIntent at Stripe using idempotency key
    try {
      if (!stripeSecret && process.env.NODE_ENV === 'test') {
        const stripeId = `test_pi_${payment.id}_${Date.now()}`;
        const updated = await tx.payment.update({ where: { id: payment.id }, data: { stripePaymentIntentId: stripeId } });
        return updated;
      }

      const body = {
        amount: String(amount),
        currency: 'usd',
        payment_method: paymentMethodId,
        confirm: 'true',
        'metadata[paymentId]': String(payment.id),
        'metadata[idempotencyKey]': idempotencyKey,
      };

      const res = await stripeRequest({ path: '/v1/payment_intents', body, idempotencyKey });
      const stripeId = res.id;

      const updated = await tx.payment.update({ where: { id: payment.id }, data: { stripePaymentIntentId: stripeId } });
      console.info({
        userId,
        paymentId: updated.id,
        stripePaymentIntentId: stripeId,
        idempotencyKey,
        outcome: 'processed',
        timestamp: new Date().toISOString(),
      }, 'Stripe payment intent created');

      return updated;
    } catch (err) {
      // Leave payment as pending/failed depending on error
      await tx.payment.update({ where: { id: payment.id }, data: { status: 'failed' } }).catch(() => {});
      throw err;
    }
  });
}

/**
 * Create a Stripe Checkout Session for the given plan and persist a pending Payment.
 * @returns {{ checkoutUrl: string, sessionId: string, payment: object }}
 */
export async function createCheckoutSession({ userId, plan }) {
  const priceId = resolvePriceId(plan);
  if (!priceId) {
    throw new PaymentServiceError(
      `Missing Stripe price configuration for plan "${plan}"`,
      {
        statusCode: 400,
        clientMessage: `No Stripe price configured for plan "${plan}". Set ${PRICE_ENV_BY_PLAN[plan] || 'STRIPE_PRICE_*'}.`,
      }
    );
  }

  const successUrl = process.env.STRIPE_CHECKOUT_SUCCESS_URL;
  const cancelUrl = process.env.STRIPE_CHECKOUT_CANCEL_URL;
  if (!successUrl || !cancelUrl) {
    throw new PaymentServiceError(
      'Missing Stripe checkout success/cancel URLs',
      {
        statusCode: 400,
        clientMessage: 'Checkout URLs are not configured. Set STRIPE_CHECKOUT_SUCCESS_URL and STRIPE_CHECKOUT_CANCEL_URL.',
      }
    );
  }

  const amount = PLAN_AMOUNTS[plan] ?? 0;
  const idempotencyKey = `checkout_${userId}_${plan}_${crypto.randomUUID()}`;
  const stripeSecret = getStripeSecret();

  const payment = await prisma.payment.create({
    data: {
      userId,
      amount,
      currency: 'usd',
      planTier: plan,
      idempotencyKey,
      status: 'pending',
    },
  });

  try {
    // Test stub: no secret → fake session (same pattern as PaymentIntents)
    if (!stripeSecret && process.env.NODE_ENV === 'test') {
      const sessionId = `cs_test_${payment.id}_${Date.now()}`;
      const checkoutUrl = `https://checkout.stripe.com/c/pay/${sessionId}`;
      const updated = await prisma.payment.update({
        where: { id: payment.id },
        data: { stripeCheckoutSessionId: sessionId },
      });
      return { checkoutUrl, sessionId, payment: updated };
    }

    // Deterministic Stripe failure path for integration tests (no network)
    if (process.env.NODE_ENV === 'test' && stripeSecret === 'sk_test_force_error') {
      const simulated = { error: { type: 'api_error', message: 'Simulated Stripe API failure' } };
      console.error({ paymentId: payment.id, stripeError: simulated }, 'Stripe checkout session failed');
      await prisma.payment.update({ where: { id: payment.id }, data: { status: 'failed' } }).catch(() => {});
      throw new PaymentServiceError('Stripe checkout session failed', {
        statusCode: 502,
        clientMessage: 'Unable to start checkout. Please try again.',
      });
    }

    const body = {
      mode: 'payment',
      success_url: successUrl,
      cancel_url: cancelUrl,
      client_reference_id: String(userId),
      'line_items[0][price]': priceId,
      'line_items[0][quantity]': '1',
      'metadata[paymentId]': String(payment.id),
      'metadata[planTier]': plan,
    };

    const session = await stripeRequest({
      path: '/v1/checkout/sessions',
      body,
      idempotencyKey,
    });

    const updated = await prisma.payment.update({
      where: { id: payment.id },
      data: { stripeCheckoutSessionId: session.id },
    });

    console.info({
      userId,
      paymentId: updated.id,
      stripeCheckoutSessionId: session.id,
      plan,
      outcome: 'checkout_session_created',
      timestamp: new Date().toISOString(),
    }, 'Stripe checkout session created');

    return {
      checkoutUrl: session.url,
      sessionId: session.id,
      payment: updated,
    };
  } catch (err) {
    if (err instanceof PaymentServiceError) throw err;

    console.error({
      paymentId: payment.id,
      userId,
      plan,
      stripeError: err,
      timestamp: new Date().toISOString(),
    }, 'Stripe checkout session failed');

    await prisma.payment.update({ where: { id: payment.id }, data: { status: 'failed' } }).catch(() => {});

    throw new PaymentServiceError('Stripe checkout session failed', {
      statusCode: 502,
      clientMessage: 'Unable to start checkout. Please try again.',
    });
  }
}

export async function markPaymentProcessed({ paymentId }) {
  return prisma.payment.update({ where: { id: paymentId }, data: { status: 'processed' } });
}

export default { createOrReusePayment, createCheckoutSession, markPaymentProcessed, PaymentServiceError };
