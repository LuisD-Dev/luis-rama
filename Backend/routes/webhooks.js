import express from 'express';
import crypto from 'crypto';
import {
  markPaymentCompleted,
  recordPaymentEvent,
  updatePaymentEventOutcome,
  findPaymentForStripeWebhook,
  PaymentNotFoundError,
} from '../services/paymentService.js';

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

  try {
    let parsed = rawBody;
    if (Buffer.isBuffer(rawBody)) parsed = rawBody.toString('utf8');
    const event = typeof parsed === 'string' ? JSON.parse(parsed) : parsed;
    const stripeEventId = event?.id;
    const eventType = event?.type;
    const paymentIntent = event.data?.object;
    const idempotencyKey = paymentIntent?.metadata?.idempotencyKey;

    if (!stripeEventId) {
      console.warn('stripe webhook missing id');
      return res.status(200).send('ok');
    }

    const { event: paymentEvent, created } = await recordPaymentEvent({
      type: eventType || 'stripe.unknown',
      payload: event,
      idempotencyKey: `stripe:${stripeEventId}`,
      stripeEventId,
      outcome: 'processing',
      processedAt: null,
    });

    if (!created) {
      console.info(
        {
          stripeEventId,
          eventType,
          idempotencyKey,
          outcome: 'duplicate',
          timestamp: new Date().toISOString(),
        },
        'duplicate webhook delivery'
      );
      return res.status(200).send('duplicate');
    }

    if (eventType === 'payment_intent.succeeded') {
      const stripeId = paymentIntent?.id;
      const metadata = paymentIntent?.metadata || {};
      const metaPaymentId =
        parseInt(String(metadata?.paymentId || ''), 10) || null;

      try {
        const payment = await findPaymentForStripeWebhook({
          stripePaymentIntentId: stripeId,
          paymentId: metaPaymentId,
          idempotencyKey,
        });

        if (!payment) {
          await updatePaymentEventOutcome(paymentEvent.id, {
            outcome: 'failed',
          });
          return res.status(200).send('ok');
        }

        const result = await markPaymentCompleted({
          paymentId: payment.id,
          subscriptionExternalId: stripeId || payment.externalId,
          eventPayload: event,
          eventIdempotencyKey: `payment.completed:${payment.id}:${stripeEventId}`,
        });

        await updatePaymentEventOutcome(paymentEvent.id, {
          paymentId: payment.id,
          outcome: result.alreadyCompleted ? 'duplicate' : 'processed',
        });

        console.info(
          {
            userId: payment.userId,
            paymentId: payment.id,
            stripeEventId,
            eventType,
            idempotencyKey,
            outcome: result.alreadyCompleted ? 'duplicate' : 'processed',
            timestamp: new Date().toISOString(),
          },
          'processed webhook event'
        );
      } catch (err) {
        if (!(err instanceof PaymentNotFoundError)) {
          console.error('Failed processing webhook:', err);
        }
        await updatePaymentEventOutcome(paymentEvent.id, {
          outcome: 'failed',
        });
      }
    } else {
      await updatePaymentEventOutcome(paymentEvent.id, {
        outcome: 'ignored',
      });
    }

    res.status(200).send('ok');
  } catch (err) {
    console.error('Invalid webhook payload', err);
    res.status(200).send('ok');
  }
});

export default router;
