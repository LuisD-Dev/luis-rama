import express from 'express';
import validate from '../middleware/validate.js';
import * as paymentSchemas from '../schemas/payment.schema.js';
import { createOrReusePayment } from '../services/paymentService.js';
import { checkout, createPaymentIntent, confirmPaymentIntent } from '../controllers/paymentsController.js';
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

      res.json({ paymentId: payment.id, stripePaymentIntentId: payment.stripePaymentIntentId, status: payment.status });
    } catch (err) {
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

export default router;
