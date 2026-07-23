import {
  createCheckoutSession,
  constructStripeEvent,
  processStripeWebhookEvent,
  PaymentServiceError,
} from '../services/paymentService.js';

export const checkout = async (req, res) => {
  try {
    const userId = req.user.id;
    const { plan } = req.body;

    const { checkoutUrl, sessionId } = await createCheckoutSession({ userId, plan });

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

/**
 * POST /api/payments/webhook — Stripe subscription lifecycle events.
 * Verifies stripe-signature against the raw body, delegates state changes to
 * paymentService, and maps the outcome to an HTTP status: 400 for a bad/missing
 * signature, 200 once the event has been recorded (handled or ignored), 500 on
 * internal failure so Stripe retries the delivery.
 */
export const stripeWebhook = async (req, res) => {
  const signature = req.headers['stripe-signature'];

  if (!signature) {
    return res.status(400).json({ error: 'Missing stripe-signature header' });
  }

  let event;
  try {
    event = constructStripeEvent(req.body, signature);
  } catch (err) {
    console.warn({ err: err.message }, 'Stripe webhook signature verification failed');
    return res.status(400).json({ error: 'Invalid signature' });
  }

  try {
    const result = await processStripeWebhookEvent(event);
    return res.status(200).json({ received: true, outcome: result.outcome });
  } catch (err) {
    console.error(
      { stripeEventId: event?.id, eventType: event?.type, err: err.message },
      'Stripe webhook processing failed'
    );
    return res.status(500).json({ error: 'Internal server error' });
  }
};

export default { checkout, stripeWebhook };
