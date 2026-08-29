import express from 'express';
import crypto from 'crypto';
import { processPaymentIntentWebhookEvent } from '../services/paymentService.js';

const router = express.Router();

// Note: route should be mounted with raw body parsing middleware in server.js
router.post('/stripe', async (req, res) => {
  const sig = req.headers['stripe-signature'];
  const rawBody = req.body;
  const webhookSecret = process.env.STRIPE_WEBHOOK_SECRET;

  if (webhookSecret && !sig) {
    console.warn('Missing Stripe signature header');
    return res.status(400).send('missing signature');
  }

  if (webhookSecret) {
    const payload = Buffer.isBuffer(rawBody)
      ? rawBody.toString('utf8')
      : JSON.stringify(rawBody);
    const signatureHeader = String(sig);
    const parts = signatureHeader.split(',');
    const timestampPart = parts.find((part) => part.startsWith('t='));
    const v1Part = parts.find((part) => part.startsWith('v1='));
    const timestamp = timestampPart ? timestampPart.slice(2) : null;
    const signature = v1Part ? v1Part.slice(3) : null;

    if (!timestamp || !signature) {
      console.warn('Invalid Stripe signature format');
      return res.status(400).send('invalid signature');
    }

    const signedPayload = `${timestamp}.${payload}`;
    const expected = crypto
      .createHmac('sha256', webhookSecret)
      .update(signedPayload)
      .digest('hex');
    const signatureBuffer = Buffer.from(signature);
    const expectedBuffer = Buffer.from(expected);

    if (
      signatureBuffer.length !== expectedBuffer.length ||
      !crypto.timingSafeEqual(signatureBuffer, expectedBuffer)
    ) {
      console.warn('Stripe webhook signature verification failed');
      return res.status(400).send('invalid signature');
    }
  }

  let event;
  try {
    let parsed = rawBody;
    if (Buffer.isBuffer(rawBody)) parsed = rawBody.toString('utf8');
    event = typeof parsed === 'string' ? JSON.parse(parsed) : parsed;
  } catch (err) {
    console.error('Invalid webhook payload', err);
    return res.status(200).send('ok');
  }

  if (!event?.id) {
    console.warn('stripe webhook missing id');
    return res.status(200).send('ok');
  }

  try {
    const result = await processPaymentIntentWebhookEvent({ event });
    console.info(
      {
        stripeEventId: event.id,
        eventType: event.type,
        paymentId: result.paymentId,
        outcome: result.outcome,
        timestamp: new Date().toISOString(),
      },
      result.outcome === 'duplicate'
        ? 'duplicate webhook delivery'
        : 'processed webhook event'
    );

    return res
      .status(200)
      .send(result.outcome === 'duplicate' ? 'duplicate' : 'ok');
  } catch (err) {
    console.error('Failed processing Stripe PaymentIntent webhook:', err);
    return res.status(500).send('webhook processing failed');
  }
});

export default router;
