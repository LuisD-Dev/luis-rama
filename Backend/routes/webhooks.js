import express from 'express';
import {
  processPaymentIntentWebhookEvent,
  processStripeWebhookEvent,
} from '../services/paymentService.js';
import {
  StripeWebhookConfigError,
  StripeWebhookPipelineError,
  StripeWebhookVerificationError,
  verifyAndParse,
} from '../services/stripeWebhook.js';

const router = express.Router();

/**
 * Dispatch a verified event without changing either payment state machine.
 * PaymentIntent events use the one-time-payment processor; all other event
 * types use the existing subscription/ignored-event processor.
 */
export const dispatchStripeWebhookEvent = (event) =>
  event?.type?.startsWith('payment_intent.')
    ? processPaymentIntentWebhookEvent({ event })
    : processStripeWebhookEvent(event);

/**
 * Shared handler for the canonical endpoint and its backwards-compatible
 * alias. Both paths therefore use the same verifier and event dispatcher.
 */
export const stripeWebhookHandler = async (req, res) => {
  let event;
  try {
    event = verifyAndParse(req.body, req.headers['stripe-signature']);
  } catch (error) {
    if (error instanceof StripeWebhookVerificationError) {
      console.warn(
        { code: error.code },
        'Stripe webhook signature or payload verification failed'
      );
      return res.status(400).json({ error: 'Invalid Stripe webhook signature or payload' });
    }

    if (error instanceof StripeWebhookConfigError) {
      console.error({ code: error.code }, 'Stripe webhook configuration is unavailable');
      return res.status(503).json({ error: 'Stripe webhook verification unavailable' });
    }

    if (error instanceof StripeWebhookPipelineError) {
      console.error({ code: error.code }, 'Stripe webhook raw-body pipeline is misconfigured');
      return res.status(500).json({ error: 'Stripe webhook processing failed' });
    }

    console.error({ error }, 'Unexpected Stripe webhook verification failure');
    return res.status(500).json({ error: 'Stripe webhook processing failed' });
  }

  try {
    const result = await dispatchStripeWebhookEvent(event);
    console.info(
      {
        stripeEventId: event.id,
        eventType: event.type,
        paymentId: result.paymentId ?? null,
        outcome: result.outcome,
        timestamp: new Date().toISOString(),
      },
      result.outcome === 'duplicate'
        ? 'duplicate webhook delivery'
        : 'processed webhook event'
    );

    return res.status(200).json({ received: true, outcome: result.outcome });
  } catch (error) {
    console.error(
      {
        stripeEventId: event?.id,
        eventType: event?.type,
        code: error?.code,
      },
      'Stripe webhook processing failed'
    );
    return res.status(500).json({ error: 'Stripe webhook processing failed' });
  }
};

// Canonical Stripe webhook endpoint: POST /api/webhooks/stripe.
router.post('/stripe', stripeWebhookHandler);

export default router;
