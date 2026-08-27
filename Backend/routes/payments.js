import express from 'express';
import { verifyToken } from '../middleware/auth.js';
import validate from '../middleware/validate.js';
import * as paymentSchemas from '../schemas/payment.schema.js';
import { submitPaymentMethod, getPaymentStatus } from '../controllers/paymentController.js';
import { paymentLimiter } from '../middleware/rateLimiter.js';

const router = express.Router();

// All payment routes require auth + rate limiting
router.post('/payment-method', paymentLimiter, verifyToken, validate(paymentSchemas.submitPaymentMethod), submitPaymentMethod);
router.get('/:id', paymentLimiter, verifyToken, getPaymentStatus);
import validate from '../middleware/validate.js';
import * as paymentSchemas from '../schemas/payment.schema.js';
import {
  createOrReusePayment,
  PaymentServiceError,
} from '../services/paymentService.js';
import { PaymentTransitionError } from '../services/paymentStateMachine.js';
import { checkout, createPaymentIntent, confirmPaymentIntent, stripeWebhook } from '../controllers/paymentsController.js';
import { verifyToken, adminOnly } from '../middleware/auth.js';

const router = express.Router();

router.post('/intent', verifyToken, createPaymentIntent);
router.post('/intent/:id/confirm', verifyToken, adminOnly, confirmPaymentIntent);

router.post(
  '/payment-method',
  verifyToken,
  validate(paymentSchemas.createPaymentMethod),
  async (req, res, next) => {
    try {
      const userId = req.user.id;
      const { paymentMethodId, planTier, idempotencyKey } = req.body;
      const headerKey = req.headers['idempotency-key'];

      const effectiveIdempotencyKey = headerKey || idempotencyKey;
      if (!effectiveIdempotencyKey) {
        return res.status(400).json({ error: 'idempotencyKey header or body field is required' });
      }

      const payment = await createOrReusePayment({
        userId,
        paymentMethodId,
        planTier,
        idempotencyKey: effectiveIdempotencyKey,
      });

      res.json({
        paymentId: payment.id,
        stripePaymentIntentId: payment.stripePaymentIntentId,
        status: payment.status,
        planTier: payment.planTier,
      });
    } catch (err) {
      if (
        err instanceof PaymentServiceError ||
        err instanceof PaymentTransitionError
      ) {
        const statusCode =
          Number.isInteger(err.statusCode) &&
          err.statusCode >= 400 &&
          err.statusCode <= 599
            ? err.statusCode
            : 500;
        const body = {
          error: err.clientMessage || err.message || 'Payment request failed',
          ...(err.code ? { code: err.code } : {}),
        };
        return res.status(statusCode).json(body);
      }
      next(err);
    }
  }
);

router.post(
  '/checkout',
  verifyToken,
  validate(paymentSchemas.createCheckout),
  checkout
);

// No verifyToken/validate: Stripe calls this directly and body must stay raw
// (see express.raw() mounted ahead of express.json() in app.js) so the
// stripe-signature header can be verified against the exact bytes sent.
router.post('/webhook', stripeWebhook);

export default router;
