import crypto from 'crypto';
import {
  confirmSimulatedPayment,
  createCheckoutSession,
  createSimulatedPayment,
  PaymentConfirmationConflictError,
  PaymentNotFoundError,
  PaymentServiceError,
} from '../services/paymentService.js';

const PLAN_AMOUNTS = { basico: 999, pro: 2499, master: 4999 };

export const checkout = async (req, res) => {
  try {
    const userId = req.user.id;
    const { plan } = req.body;
    const ipHash = req._riskIpHash || null;

    const { checkoutUrl, sessionId } = await createCheckoutSession({ userId, plan, ipHash });

    return res.json({ checkoutUrl, sessionId });
  } catch (err) {
    console.error({
      err: err instanceof PaymentServiceError ? err.message : err,
      stack: err?.stack,
      stripeDetails: err?.cause || undefined,
      timestamp: new Date().toISOString(),
    }, 'Checkout endpoint error');

    if (err instanceof PaymentServiceError) {
      return res.status(err.statusCode).json({ error: err.clientMessage });
    }

    return res.status(502).json({ error: 'Unable to start checkout. Please try again.' });
  }
};

// Stripe documentation: This endpoint is a temporary simulation.
// In production, payment intent creation will be handled by Stripe
// (via POST /api/payments/checkout or Stripe Elements).
// Once Stripe is fully integrated, this endpoint can be deprecated.

export const createPaymentIntent = async (req, res) => {
  try {
    const { plan_tier } = req.body;
    const userId = req.user.id;

    if (!plan_tier || !PLAN_AMOUNTS[plan_tier]) {
      return res.status(400).json({ error: 'invalid_plan' });
    }

    if (req.user.role === 'admin') {
      return res.status(403).json({ error: 'admin_not_allowed' });
    }

    const payment = await createSimulatedPayment({
      userId,
      planTier: plan_tier,
      idempotencyKey: `intent_${userId}_${plan_tier}_${crypto.randomUUID()}`,
    });

    return res.status(201).json({
      paymentId: payment.id,
      status: payment.status,
      plan_tier: payment.planTier,
      amount: payment.amount,
    });
  } catch (err) {
    console.error(err);
    return res.status(500).json({ error: 'internal_error' });
  }
};

// Stripe documentation: This confirm endpoint is a temporary simulation.
// In production, payment confirmation will be handled by Stripe webhooks
// (POST /api/webhooks/stripe listening to payment_intent.succeeded).
// Once Stripe is integrated, remove this endpoint and rely on webhook idempotency.

export const confirmPaymentIntent = async (req, res) => {
  try {
    if (!req.user || req.user.role !== 'admin') {
      return res.status(403).json({ error: 'forbidden' });
    }

    const result = await confirmSimulatedPayment({
      paymentId: Number(req.params.id),
      actorId: req.user.id,
    });

    return res.json({
      paymentId: result.id,
      status: result.status,
      plan_tier: result.planTier,
      amount: result.amount,
    });
  } catch (err) {
    if (err instanceof PaymentNotFoundError) {
      return res.status(404).json({ error: 'payment_not_found' });
    }
    if (err instanceof PaymentConfirmationConflictError) {
      return res.status(409).json({
        error: 'payment_already_processed',
        currentStatus: err.currentStatus,
      });
    }
    console.error(err);
    return res.status(500).json({ error: 'internal_error' });
  }
};

export default { checkout, createPaymentIntent, confirmPaymentIntent };
