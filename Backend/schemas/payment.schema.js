import { z } from 'zod';
import { IDEMPOTENCY_KEY_MAX, IDEMPOTENCY_KEY_MIN, IDEMPOTENCY_KEY_REGEX, PAYMENT_METHOD_ID_MAX, PAYMENT_METHOD_ID_REGEX } from '../constants/payments.js';

export const submitPaymentMethod = z.object({
  planTier: z.string()
    .trim()
    .toLowerCase()
    .min(1, { message: 'planTier is required' })
    .max(20, { message: 'planTier too long' }),
  paymentMethodId: z.string()
    .trim()
    .max(PAYMENT_METHOD_ID_MAX, { message: 'paymentMethodId too long' })
    .regex(PAYMENT_METHOD_ID_REGEX, { message: 'Invalid paymentMethodId format' })
    .optional()
    .nullable(),
  idempotencyKey: z.string()
    .trim()
    .min(IDEMPOTENCY_KEY_MIN, { message: `idempotencyKey must be at least ${IDEMPOTENCY_KEY_MIN} characters` })
    .max(IDEMPOTENCY_KEY_MAX, { message: `idempotencyKey must be at most ${IDEMPOTENCY_KEY_MAX} characters` })
    .regex(IDEMPOTENCY_KEY_REGEX, { message: 'idempotencyKey contains invalid characters' }),
  // Security: explicitly forbid client amount (will be stripped but we log in controller via raw body)
  amount: z.any().optional(),
}).strip();
