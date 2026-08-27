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

export default router;
