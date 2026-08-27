import crypto from 'crypto';
import prisma from '../utils/prismaClient.js';
import {
  ALLOWED_PLAN_TIERS,
  PLAN_AMOUNTS,
  PAYMENT_STATUS,
  PAYMENT_CODE,
  IDEMPOTENCY_KEY_MIN,
  IDEMPOTENCY_KEY_MAX,
  IDEMPOTENCY_KEY_REGEX,
  PAYMENT_METHOD_ID_MAX,
  PAYMENT_METHOD_ID_REGEX,
} from '../constants/payments.js';

const generatePaymentIntentId = () => `pi_${crypto.randomBytes(12).toString('hex')}`;

export const validatePlanTier = (planTier) => {
  return ALLOWED_PLAN_TIERS.includes(planTier);
};

export const getAmountForPlan = (planTier) => PLAN_AMOUNTS[planTier] ?? null;

const isTestHintAllowed = () => {
  // Test hints (fail/pending in idempotencyKey) only allowed outside production
  // Prevents attackers in prod from forcing statuses via crafted keys.
  if (process.env.NODE_ENV === 'production' && process.env.ALLOW_TEST_KEY_HINTS !== 'true') {
    return false;
  }
  return true;
};

const determineMockStatus = (normalizedKey) => {
  // In production, never auto-succeed without real Stripe verification.
  // Default to processing and require webhook confirmation.
  if (process.env.NODE_ENV === 'production' && process.env.STRIPE_MOCK_ENABLED !== 'true' && !isTestHintAllowed()) {
    return { status: PAYMENT_STATUS.PROCESSING, code: PAYMENT_CODE.PROCESSING, clientMessage: 'Payment is being confirmed...' };
  }
  // Test/demo mode: allow deterministic hints for integration tests
  if (isTestHintAllowed()) {
    if (normalizedKey.includes('fail')) {
      return { status: PAYMENT_STATUS.FAILED, code: PAYMENT_CODE.FAILED, clientMessage: 'Payment failed. Please try again with a new card.' };
    }
    if (normalizedKey.includes('pending') || normalizedKey.includes('processing')) {
      return { status: PAYMENT_STATUS.PROCESSING, code: PAYMENT_CODE.PROCESSING, clientMessage: 'Payment is being confirmed...' };
    }
  }
  // For non-prod demo, immediate success is convenient. In prod with STRIPE_MOCK_ENABLED, also allow success.
  // Otherwise default to processing for safety.
  if (process.env.NODE_ENV === 'production' && !process.env.STRIPE_MOCK_ENABLED) {
    return { status: PAYMENT_STATUS.PROCESSING, code: PAYMENT_CODE.PROCESSING, clientMessage: 'Payment is being confirmed...' };
  }
  return { status: PAYMENT_STATUS.SUCCEEDED, code: PAYMENT_CODE.SUCCEEDED, clientMessage: null };
};

const validateInputs = ({ planTier, paymentMethodId, idempotencyKey }) => {
  // Extra defense-in-depth beyond zod (in case controller bypassed)
  if (typeof planTier !== 'string' || !ALLOWED_PLAN_TIERS.includes(planTier)) {
    const err = new Error(`Invalid planTier. Allowed: ${ALLOWED_PLAN_TIERS.join(', ')}`);
    err.status = 400;
    err.code = PAYMENT_CODE.INVALID_PLAN;
    throw err;
  }
  if (typeof idempotencyKey !== 'string' || idempotencyKey.trim().length < IDEMPOTENCY_KEY_MIN || idempotencyKey.trim().length > IDEMPOTENCY_KEY_MAX) {
    const err = new Error(`idempotencyKey must be ${IDEMPOTENCY_KEY_MIN}-${IDEMPOTENCY_KEY_MAX} characters`);
    err.status = 400;
    err.code = PAYMENT_CODE.VALIDATION_ERROR;
    throw err;
  }
  if (!IDEMPOTENCY_KEY_REGEX.test(idempotencyKey.trim())) {
    const err = new Error('idempotencyKey contains invalid characters');
    err.status = 400;
    err.code = PAYMENT_CODE.VALIDATION_ERROR;
    throw err;
  }
  if (paymentMethodId != null) {
    if (typeof paymentMethodId !== 'string' || paymentMethodId.length > PAYMENT_METHOD_ID_MAX || !PAYMENT_METHOD_ID_REGEX.test(paymentMethodId.trim())) {
      const err = new Error('Invalid paymentMethodId format');
      err.status = 400;
      err.code = PAYMENT_CODE.VALIDATION_ERROR;
      throw err;
    }
  }
};

/**
 * Creates or returns existing payment for idempotency.
 * Business rules:
 * - Validate planTier allowlist (defense-in-depth)
 * - Reject admin users
 * - Never trust client amount; amount from server map
 * - Idempotency key scoped to userId
 * - Handles race condition via P2002 catch
 */
export const createPayment = async ({ user, planTier, paymentMethodId, idempotencyKey }) => {
  if (!user || typeof user.id !== 'number' || typeof user.role !== 'string') {
    const err = new Error('Invalid user context');
    err.status = 401;
    err.code = PAYMENT_CODE.UNAUTHORIZED;
    throw err;
  }

  if (user.role === 'admin') {
    const err = new Error('Admin users cannot purchase plans');
    err.status = 403;
    err.code = PAYMENT_CODE.ADMIN_FORBIDDEN;
    throw err;
  }

  // Normalize inputs (trim + lowercase planTier)
  const normalizedPlan = typeof planTier === 'string' ? planTier.trim().toLowerCase() : planTier;
  const normalizedKey = typeof idempotencyKey === 'string' ? idempotencyKey.trim() : idempotencyKey;
  const normalizedPmId = typeof paymentMethodId === 'string' ? paymentMethodId.trim() : paymentMethodId;

  validateInputs({ planTier: normalizedPlan, paymentMethodId: normalizedPmId, idempotencyKey: normalizedKey });

  if (!validatePlanTier(normalizedPlan)) {
    const err = new Error(`Invalid planTier. Allowed: ${ALLOWED_PLAN_TIERS.join(', ')}`);
    err.status = 400;
    err.code = PAYMENT_CODE.INVALID_PLAN;
    throw err;
  }

  // Idempotency: return existing payment if found (same user + same key)
  const existing = await prisma.payment.findUnique({
    where: {
      userId_idempotencyKey: {
        userId: user.id,
        idempotencyKey: normalizedKey,
      },
    },
  });

  if (existing) {
    return existing;
  }

  const amount = PLAN_AMOUNTS[normalizedPlan];
  const { status, code, clientMessage } = determineMockStatus(normalizedKey);
  const stripePaymentIntentId = generatePaymentIntentId();

  let payment;
  try {
    payment = await prisma.payment.create({
      data: {
        userId: user.id,
        planTier: normalizedPlan,
        amount,
        currency: 'usd',
        status,
        code,
        idempotencyKey: normalizedKey,
        stripePaymentIntentId,
        stripePaymentMethodId: normalizedPmId || null,
        clientMessage,
      },
    });
  } catch (err) {
    // Handle race: P2002 unique constraint violation -> return existing
    if (err.code === 'P2002' || err.message?.includes('Unique constraint failed')) {
      const raceExisting = await prisma.payment.findUnique({
        where: {
          userId_idempotencyKey: {
            userId: user.id,
            idempotencyKey: normalizedKey,
          },
        },
      });
      if (raceExisting) return raceExisting;
    }
    throw err;
  }

  // If status is succeeded, also update user planTier (activate entitlements)
  // In production with real Stripe, this should be via webhook after confirmation.
  // For succeeded immediate path, we activate synchronously.
  if (status === PAYMENT_STATUS.SUCCEEDED) {
    // Use transaction-like safety: ensure user still exists and not admin
    const freshUser = await prisma.user.findUnique({ where: { id: user.id }, select: { role: true } });
    if (freshUser && freshUser.role !== 'admin') {
      await prisma.user.update({
        where: { id: user.id },
        data: { planTier: normalizedPlan },
      });
    }
  }

  return payment;
};

export const getPaymentById = async ({ paymentId, userId }) => {
  if (!Number.isInteger(paymentId) || paymentId <= 0) {
    const err = new Error('Invalid payment id');
    err.status = 400;
    err.code = PAYMENT_CODE.VALIDATION_ERROR;
    throw err;
  }
  if (!Number.isInteger(userId) || userId <= 0) {
    const err = new Error('Invalid user context');
    err.status = 401;
    err.code = PAYMENT_CODE.UNAUTHORIZED;
    throw err;
  }

  const payment = await prisma.payment.findUnique({
    where: { id: paymentId },
  });

  if (!payment) {
    const err = new Error('Payment not found');
    err.status = 404;
    err.code = PAYMENT_CODE.NOT_FOUND;
    throw err;
  }

  if (payment.userId !== userId) {
    const err = new Error('Forbidden: payment does not belong to user');
    err.status = 403;
    err.code = PAYMENT_CODE.UNAUTHORIZED;
    throw err;
  }

  return payment;
};

export const formatPaymentResponse = (payment) => ({
  status: payment.status,
  code: payment.code,
  paymentId: payment.id,
  stripePaymentIntentId: payment.stripePaymentIntentId,
  planTier: payment.planTier,
  amount: payment.amount,
  currency: payment.currency,
  clientMessage: payment.clientMessage ?? null,
  idempotencyKey: payment.idempotencyKey,
  createdAt: payment.createdAt,
  updatedAt: payment.updatedAt,
});

/**
 * For polling simulation: allow external update to succeeded.
 * Webhook would call this - should verify Stripe signature in prod.
 */
export const confirmPayment = async (paymentId) => {
  if (!Number.isInteger(paymentId) || paymentId <= 0) return null;
  const payment = await prisma.payment.findUnique({ where: { id: paymentId } });
  if (!payment) return null;
  if (payment.status === PAYMENT_STATUS.SUCCEEDED) return payment;
  // Only allow transitioning from non-terminal
  if (![PAYMENT_STATUS.PENDING, PAYMENT_STATUS.PROCESSING].includes(payment.status)) {
    return payment;
  }
  const updated = await prisma.payment.update({
    where: { id: paymentId },
    data: {
      status: PAYMENT_STATUS.SUCCEEDED,
      code: PAYMENT_CODE.SUCCEEDED,
      clientMessage: null,
    },
  });
  // Activate entitlements if user not admin
  const user = await prisma.user.findUnique({ where: { id: payment.userId }, select: { role: true } });
  if (user && user.role !== 'admin') {
    await prisma.user.update({
      where: { id: payment.userId },
      data: { planTier: payment.planTier },
    });
  }
  return updated;
};
