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
import https from 'https';
import Stripe from 'stripe';
import prisma from '../utils/prismaClient.js';
import { PLAN_TIERS, normalizePlanTier } from '../utils/plans.js';
import {
  PAYMENT_STATUSES,
  PaymentTransitionError,
  applyTransition,
  createPaymentInPendingState,
} from './paymentStateMachine.js';
import { setUserPlanTier } from './entitlementService.js';

const STRIPE_API_BASE = 'api.stripe.com';

const PLAN_AMOUNTS = {
  [PLAN_TIERS.BASICO]: 999,
  [PLAN_TIERS.PRO]: 2499,
  [PLAN_TIERS.MASTER]: 4999,
};

const PAID_PLAN_TIERS = new Set([
  PLAN_TIERS.BASICO,
  PLAN_TIERS.PRO,
  PLAN_TIERS.MASTER,
]);

const PRICE_ENV_BY_PLAN = {
  [PLAN_TIERS.BASICO]: 'STRIPE_PRICE_BASICO',
  [PLAN_TIERS.PRO]: 'STRIPE_PRICE_PRO',
  [PLAN_TIERS.MASTER]: 'STRIPE_PRICE_MASTER',
};

const DEFAULT_PERIOD_MS = 30 * 24 * 60 * 60 * 1000;

const SUBSCRIPTION_EVENT_TYPES = new Set([
  'checkout.session.completed',
  'invoice.paid',
  'invoice.payment_failed',
  'customer.subscription.updated',
  'customer.subscription.deleted',
]);

const PAYMENT_INTENT_EVENT_TYPES = new Set([
  'payment_intent.processing',
  'payment_intent.succeeded',
  'payment_intent.payment_failed',
  'payment_intent.canceled',
]);

export class PaymentServiceError extends Error {
  constructor(message, { statusCode = 502, clientMessage } = {}) {
    super(message);
    this.name = 'PaymentServiceError';
    this.statusCode = statusCode;
    this.clientMessage = clientMessage || message;
  }
}

export class InvalidPlanError extends PaymentServiceError {
  constructor(planTier) {
    super(`Invalid plan tier: ${planTier}`, {
      statusCode: 400,
      clientMessage: `Plan no válido. Opciones: basico, pro, master`,
    });
    this.name = 'InvalidPlanError';
  }
}

export class PaymentNotFoundError extends PaymentServiceError {
  constructor() {
    super('Payment not found', {
      statusCode: 404,
      clientMessage: 'Payment not found',
    });
    this.name = 'PaymentNotFoundError';
  }
}

export class PaymentIdempotencyConflictError extends PaymentServiceError {
  constructor() {
    super('Payment idempotency key conflicts with the requested payment', {
      statusCode: 409,
      clientMessage: 'The idempotency key was already used for another payment request.',
    });
    this.name = 'PaymentIdempotencyConflictError';
    this.code = 'PAYMENT_IDEMPOTENCY_CONFLICT';
  }
}

export class PaymentIntentConflictError extends PaymentServiceError {
  constructor() {
    super('Payment already references a different Stripe PaymentIntent', {
      statusCode: 409,
      clientMessage: 'The payment conflicts with an existing Stripe payment intent.',
    });
    this.name = 'PaymentIntentConflictError';
    this.code = 'PAYMENT_INTENT_CONFLICT';
  }
}

export class PaymentConfirmationConflictError extends PaymentServiceError {
  constructor(currentStatus) {
    super('Payment is not confirmable from its current status', {
      statusCode: 409,
      clientMessage: 'payment_already_processed',
    });
    this.name = 'PaymentConfirmationConflictError';
    this.code = 'PAYMENT_CONFIRMATION_CONFLICT';
    this.currentStatus = currentStatus;
  }
}

export class PaymentWebhookProcessingError extends PaymentServiceError {
  constructor(message, { code = 'PAYMENT_WEBHOOK_PROCESSING_FAILED', cause } = {}) {
    super(message, {
      statusCode: 500,
      clientMessage: 'The payment webhook could not be processed.',
    });
    this.name = 'PaymentWebhookProcessingError';
    this.code = code;
    this.retryable = true;
    if (cause !== undefined) this.cause = cause;
  }
}

export class StripePaymentRequestError extends PaymentServiceError {
  constructor(cause) {
    super('Stripe PaymentIntent request did not return an authoritative result', {
      statusCode: 502,
      clientMessage: 'Payment processing is temporarily unavailable. Please try again.',
    });
    this.name = 'StripePaymentRequestError';
    this.code = 'PAYMENT_PROVIDER_UNAVAILABLE';
    this.retryable = true;
    this.cause = cause;
  }
}

export class StripePaymentIntentError extends PaymentServiceError {
  constructor(cause) {
    super('Stripe returned an unsuccessful authoritative PaymentIntent response', {
      statusCode: 402,
      clientMessage: 'The payment could not be completed.',
    });
    this.name = 'StripePaymentIntentError';
    this.code = 'STRIPE_PAYMENT_INTENT_FAILED';
    this.retryable = false;
    this.cause = cause;
  }
}

export class StripeCheckoutRequestError extends PaymentServiceError {
  constructor(cause, { retryable }) {
    super('Stripe Checkout Session request failed', {
      statusCode: 502,
      clientMessage: 'Unable to start checkout. Please try again.',
    });
    this.name = 'StripeCheckoutRequestError';
    this.code = retryable
      ? 'PAYMENT_PROVIDER_UNAVAILABLE'
      : 'STRIPE_CHECKOUT_REJECTED';
    this.retryable = retryable;
    this.providerResponded = cause?.providerResponded === true;
    this.cause = cause;
  }
}

const getStripeSecret = () => process.env.STRIPE_SECRET_KEY || '';

let cachedStripeClient = null;
let cachedStripeClientKey = null;

/**
 * Lazily construct a Stripe SDK client. Used only for local/offline operations
 * (webhook signature construction) — the rest of this module talks to Stripe
 * over raw HTTPS via `stripeRequest`. A placeholder key is used when
 * STRIPE_SECRET_KEY is not configured (e.g. tests), since signature
 * verification does not make network calls.
 */
export const getStripeClient = () => {
  const key = getStripeSecret() || 'sk_test_placeholder_key_for_signature_verification';
  if (!cachedStripeClient || cachedStripeClientKey !== key) {
    cachedStripeClient = new Stripe(key);
    cachedStripeClientKey = key;
  }
  return cachedStripeClient;
};

/**
 * Verify a Stripe webhook request and return the parsed event.
 * Throws Stripe.errors.StripeSignatureVerificationError on invalid/missing signature.
 */
export function constructStripeEvent(rawBody, signatureHeader) {
  const webhookSecret = process.env.STRIPE_WEBHOOK_SECRET;
  if (!webhookSecret) {
    throw new PaymentServiceError('Missing STRIPE_WEBHOOK_SECRET', {
      statusCode: 500,
      clientMessage: 'Webhook not configured',
    });
  }
  return getStripeClient().webhooks.constructEvent(rawBody, signatureHeader, webhookSecret);
}

const resolvePlanTierForPriceId = (priceId) => {
  if (!priceId) return null;
  for (const [plan, envKey] of Object.entries(PRICE_ENV_BY_PLAN)) {
    if (process.env[envKey] && process.env[envKey] === priceId) {
      return plan;
    }
  }
  return null;
};

const toDateFromUnixSeconds = (unixSeconds) =>
  typeof unixSeconds === 'number' ? new Date(unixSeconds * 1000) : null;

const mapStripeSubscriptionStatus = (stripeStatus) => {
  switch (stripeStatus) {
    case 'active':
    case 'trialing':
      return 'active';
    case 'canceled':
    case 'incomplete_expired':
      return 'canceled';
    case 'past_due':
    case 'unpaid':
    case 'incomplete':
    default:
      return 'past_due';
  }
};

class StripeHttpResponseError extends Error {
  constructor(httpStatus, stripeError) {
    super('Stripe rejected the API request');
    this.name = 'StripeHttpResponseError';
    this.providerResponded = true;
    this.authoritativeFailure = true;
    this.httpStatus = httpStatus;
    this.stripeError = stripeError;
    this.error = stripeError?.error;
    this.payment_intent = stripeError?.payment_intent;
    this.retryable = false;
  }
}

class StripeUnusableResponseError extends Error {
  constructor(httpStatus, stripeError) {
    super('Stripe returned an unusable success response');
    this.name = 'StripeUnusableResponseError';
    this.providerResponded = true;
    this.authoritativeFailure = false;
    this.httpStatus = httpStatus;
    this.stripeError = stripeError;
    this.retryable = true;
  }
}

const stripeRequest = ({ path, method = 'POST', body, idempotencyKey }) =>
  new Promise((resolve, reject) => {
    const data = new URLSearchParams(body).toString();
    const stripeSecret = getStripeSecret();
    const options = {
      hostname: STRIPE_API_BASE,
      path,
      method,
      headers: {
        Authorization: `Bearer ${stripeSecret}`,
        'Content-Type': 'application/x-www-form-urlencoded',
        'Content-Length': Buffer.byteLength(data),
        ...(idempotencyKey ? { 'Idempotency-Key': idempotencyKey } : {}),
      },
    };

    const req = https.request(options, (res) => {
      let raw = '';
      res.setEncoding('utf8');
      res.on('data', (chunk) => {
        raw += chunk;
      });
      res.on('end', () => {
        const isSuccessfulResponse =
          res.statusCode && res.statusCode >= 200 && res.statusCode < 300;
        try {
          const parsed = JSON.parse(raw);
          if (isSuccessfulResponse) {
            resolve(parsed);
          } else {
            reject(new StripeHttpResponseError(res.statusCode, parsed));
          }
        } catch (err) {
          if (isSuccessfulResponse) {
            // Stripe may have created the remote object even though its success
            // response was unusable locally, so this remains ambiguous.
            err.providerResponded = true;
            err.authoritativeFailure = false;
            err.httpStatus = res.statusCode;
            err.stripeError = raw;
            err.retryable = true;
            reject(err);
          } else {
            reject(new StripeHttpResponseError(res.statusCode, raw));
          }
        }
      });
    });

    req.on('error', (err) => reject(err));
    req.write(data);
    req.end();
  });

const resolvePriceId = (plan) => {
  const envKey = PRICE_ENV_BY_PLAN[plan];
  if (!envKey) return null;
  return process.env[envKey] || null;
};

const assertPaidPlan = (planTier) => {
  const normalized = normalizePlanTier(planTier);
  if (!normalized || !PAID_PLAN_TIERS.has(normalized)) {
    throw new InvalidPlanError(planTier);
  }
  return normalized;
};

const serializeMetadata = (metadata) => {
  if (metadata == null) return null;
  if (typeof metadata === 'string') return metadata;
  return JSON.stringify(metadata);
};

const paymentInitializationMeta = ({ source, actorType, actorId, reason }) => ({
  source,
  actorType,
  actorId,
  reason,
});

/**
 * Persist a pending payment intent row. Idempotent on `idempotencyKey`.
 */
export async function createPaymentIntent(
  {
    userId,
    planTier,
    amount,
    currency = 'usd',
    provider = 'stripe',
    externalId = null,
    idempotencyKey,
    metadata = null,
    paymentMethodId = null,
    stripePaymentIntentId = null,
    stripeCheckoutSessionId = null,
    tx,
  } = {},
  { db = prisma } = {}
) {
  if (!idempotencyKey) {
    throw new PaymentServiceError('idempotencyKey required', {
      statusCode: 400,
      clientMessage: 'idempotencyKey is required',
    });
  }

  const normalizedPlan = assertPaidPlan(planTier);
  const amountCents =
    typeof amount === 'number' ? amount : PLAN_AMOUNTS[normalizedPlan] ?? 0;

  const createOrLoad = async (client) => {
    const existing = await client.payment.findUnique({ where: { idempotencyKey } });
    if (existing) return existing;

    return createPaymentInPendingState(
      client,
      {
        userId,
        amount: amountCents,
        currency,
        planTier: normalizedPlan,
        provider,
        externalId,
        paymentMethodId,
        stripePaymentIntentId,
        stripeCheckoutSessionId,
        idempotencyKey,
        ipHash,
        metadata: serializeMetadata(metadata),
      },
      paymentInitializationMeta({
        source: provider === 'simulated' ? 'simulated_payment_api' : 'payment_service',
        actorType: 'system',
        actorId: userId,
        reason: 'payment initialized',
      })
    );
  };

  if (tx) return createOrLoad(tx);

  try {
    return await db.$transaction(createOrLoad);
  } catch (error) {
    if (error?.code !== 'P2002') throw error;
    const raced = await db.payment.findUnique({ where: { idempotencyKey } });
    if (raced) return raced;
    throw error;
  }
}

/**
 * Append a payment audit event. Idempotent on `idempotencyKey` (and `stripeEventId` when set).
 * Returns `{ event, created }`.
 */
export async function recordPaymentEvent({
  paymentId = null,
  type,
  payload,
  idempotencyKey,
  stripeEventId = null,
  outcome = null,
  processedAt = new Date(),
  tx = prisma,
} = {}) {
  if (!idempotencyKey) {
    throw new PaymentServiceError('idempotencyKey required', {
      statusCode: 400,
      clientMessage: 'idempotencyKey is required',
    });
  }
  if (!type) {
    throw new PaymentServiceError('event type required', {
      statusCode: 400,
      clientMessage: 'event type is required',
    });
  }

  const existing = await tx.paymentEvent.findUnique({
    where: { idempotencyKey },
  });
  if (existing) return { event: existing, created: false };

  if (stripeEventId) {
    const byStripe = await tx.paymentEvent.findUnique({
      where: { stripeEventId },
    });
    if (byStripe) return { event: byStripe, created: false };
  }

  try {
    const event = await tx.paymentEvent.create({
      data: {
        paymentId,
        type,
        payload:
          typeof payload === 'string' ? payload : JSON.stringify(payload ?? {}),
        idempotencyKey,
        stripeEventId,
        outcome,
        processedAt,
      },
    });
    return { event, created: true };
  } catch (err) {
    // Unique race: re-fetch and treat as duplicate
    if (err?.code === 'P2002') {
      const raced =
        (await tx.paymentEvent.findUnique({ where: { idempotencyKey } })) ||
        (stripeEventId
          ? await tx.paymentEvent.findUnique({ where: { stripeEventId } })
          : null);
      if (raced) return { event: raced, created: false };
    }
    throw err;
  }
}

const resolvePayment = async (tx, { paymentId, idempotencyKey, externalId }) => {
  if (paymentId != null) {
    const byId = await tx.payment.findUnique({ where: { id: Number(paymentId) } });
    if (byId) return byId;
  }
  if (idempotencyKey) {
    const byKey = await tx.payment.findUnique({ where: { idempotencyKey } });
    if (byKey) return byKey;
  }
  if (externalId) {
    const byExternal = await tx.payment.findFirst({ where: { externalId } });
    if (byExternal) return byExternal;
  }
  return null;
};

const LEGACY_SUCCESS_PAYMENT_STATUSES = new Set(['completed', 'processed']);

const nextCanonicalSuccessStatus = (status) => {
  switch (status) {
    case PAYMENT_STATUSES.CREATED:
      return PAYMENT_STATUSES.PENDING;
    case PAYMENT_STATUSES.PENDING:
      return PAYMENT_STATUSES.PROCESSING;
    case PAYMENT_STATUSES.PROCESSING:
      return PAYMENT_STATUSES.SUCCEEDED;
    default:
      return null;
  }
};

const convergePaymentToSucceeded = async (tx, payment, meta) => {
  let current = payment;

  for (let step = 0; step < 4; step += 1) {
    if (current.status === PAYMENT_STATUSES.SUCCEEDED) {
      return { payment: current, wonSucceededTransition: false, outcome: 'already_succeeded' };
    }
    if (LEGACY_SUCCESS_PAYMENT_STATUSES.has(current.status)) {
      return {
        payment: current,
        wonSucceededTransition: false,
        outcome: 'legacy_already_succeeded',
      };
    }

    const targetStatus = nextCanonicalSuccessStatus(current.status);
    if (!targetStatus) {
      throw new PaymentTransitionError(current.status, PAYMENT_STATUSES.SUCCEEDED, {
        paymentId: current.id,
        currentStatus: current.status,
      });
    }

    const transition = await applyTransition(tx, current.id, targetStatus, meta);
    current = transition.payment;

    const wonSucceededTransition =
      transition.applied === true &&
      transition.previousStatus === PAYMENT_STATUSES.PROCESSING &&
      transition.targetStatus === PAYMENT_STATUSES.SUCCEEDED;
    if (wonSucceededTransition) {
      return { payment: current, wonSucceededTransition: true, outcome: 'processed' };
    }
  }

  throw new PaymentTransitionError(current.status, PAYMENT_STATUSES.SUCCEEDED, {
    paymentId: current.id,
    currentStatus: current.status,
  });
};

const activateCompletedPaymentEntitlement = (tx, { payment }) =>
  setUserPlanTier(
    {
      userId: payment.userId,
      planTier: payment.planTier,
      extraData: { role: 'premium' },
      reason: 'payment_completed',
      actor: 'stripe',
    },
    tx
  );

/**
 * Mark a payment completed and activate the user's subscription/plan in one transaction.
 */
export async function markPaymentCompleted(
  {
    paymentId,
    idempotencyKey,
    externalId,
    subscriptionExternalId,
    currentPeriodStart,
    currentPeriodEnd,
    eventPayload = null,
    eventIdempotencyKey = null,
  } = {},
  { db = prisma, entitlementWriter = activateCompletedPaymentEntitlement } = {}
) {
  return db.$transaction(async (tx) => {
    const payment = await resolvePayment(tx, {
      paymentId,
      idempotencyKey,
      externalId,
    });

    if (!payment) {
      throw new PaymentNotFoundError();
    }

    const convergence = await convergePaymentToSucceeded(tx, payment, {
      source: 'payment_completion_service',
      actorType: 'system',
      actorId: payment.id,
      reason: 'payment completion requested',
    });
    if (!convergence.wonSucceededTransition) {
      return {
        payment: convergence.payment,
        subscription: await tx.subscription.findFirst({
          where: {
            userId: convergence.payment.userId,
            provider: convergence.payment.provider,
            status: 'active',
          },
          orderBy: { id: 'desc' },
        }),
        alreadyCompleted: true,
      };
    }

    const succeededPayment = convergence.payment;

    const now = new Date();
    const periodStart = currentPeriodStart
      ? new Date(currentPeriodStart)
      : now;
    const periodEnd = currentPeriodEnd
      ? new Date(currentPeriodEnd)
      : new Date(periodStart.getTime() + DEFAULT_PERIOD_MS);

    const subExternalId =
      subscriptionExternalId ||
      succeededPayment.externalId ||
      succeededPayment.stripePaymentIntentId ||
      succeededPayment.stripeCheckoutSessionId ||
      `payment_${succeededPayment.id}`;

    const updatedPayment = await tx.payment.update({
      where: { id: succeededPayment.id },
      data: {
        externalId: succeededPayment.externalId || subExternalId,
        updatedAt: now,
      },
    });

    const existingSub = await tx.subscription.findUnique({
      where: {
        provider_externalId: {
          provider: succeededPayment.provider,
          externalId: subExternalId,
        },
      },
    });

    const subscription = existingSub
      ? await tx.subscription.update({
          where: { id: existingSub.id },
          data: {
            planTier: succeededPayment.planTier,
            status: 'active',
            currentPeriodStart: periodStart,
            currentPeriodEnd: periodEnd,
          },
        })
      : await tx.subscription.create({
          data: {
            userId: succeededPayment.userId,
            planTier: succeededPayment.planTier,
            status: 'active',
            provider: succeededPayment.provider,
            externalId: subExternalId,
            currentPeriodStart: periodStart,
            currentPeriodEnd: periodEnd,
          },
        });

    await entitlementWriter(tx, { payment: updatedPayment, subscription });

    await recordPaymentEvent({
      paymentId: succeededPayment.id,
      type: 'payment.completed',
      payload: eventPayload ?? {
        paymentId: succeededPayment.id,
        planTier: succeededPayment.planTier,
        subscriptionId: subscription.id,
      },
      idempotencyKey:
        eventIdempotencyKey || `payment.completed:${succeededPayment.id}`,
      outcome: 'processed',
      processedAt: now,
      tx,
    });

    return {
      payment: updatedPayment,
      subscription,
      alreadyCompleted: false,
    };
  });
}

/** Convenience: unwrap recordPaymentEvent for callers that only need the row. */
export async function ensurePaymentEvent(args) {
  const { event } = await recordPaymentEvent(args);
  return event;
}

export async function updatePaymentEventOutcome(
  eventId,
  { paymentId, outcome, processedAt = new Date() }
) {
  return prisma.paymentEvent.update({
    where: { id: eventId },
    data: {
      ...(paymentId != null ? { paymentId } : {}),
      outcome,
      processedAt,
    },
  });
}

const writeAuditLog = (
  tx,
  { actor = 'stripe-webhook', action, entityType, entityId = null, before = null, after = null }
) =>
  tx.auditLog.create({
    data: {
      actor,
      action,
      entityType,
      entityId,
      beforeState: before == null ? null : JSON.stringify(before),
      afterState: after == null ? null : JSON.stringify(after),
    },
  });

const applyUserEntitlements = (tx, { userId, planTier, role }) =>
  setUserPlanTier(
    {
      userId,
      planTier,
      extraData: { role },
      reason: 'entitlement_apply',
      actor: 'system',
    },
    tx
  );

const findLocalSubscriptionByExternalId = (tx, externalId) =>
  tx.subscription.findUnique({
    where: { provider_externalId: { provider: 'stripe', externalId } },
  });

const upsertLocalSubscription = async (
  tx,
  { userId, planTier, status, externalId, currentPeriodStart, currentPeriodEnd }
) => {
  const existing = await findLocalSubscriptionByExternalId(tx, externalId);
  if (existing) {
    return tx.subscription.update({
      where: { id: existing.id },
      data: { planTier, status, currentPeriodStart, currentPeriodEnd },
    });
  }
  return tx.subscription.create({
    data: {
      userId,
      planTier,
      status,
      provider: 'stripe',
      externalId,
      currentPeriodStart,
      currentPeriodEnd,
    },
  });
};

/**
 * checkout.session.completed — only meaningful for mode:'subscription' sessions
 * created by createCheckoutSession. Activates the local Subscription + user
 * entitlements and captures the Stripe customer id for later webhook lookups.
 */
async function handleCheckoutSessionCompleted(tx, session) {
  if (session.mode !== 'subscription' || !session.subscription) {
    return { outcome: 'ignored' };
  }

  const metaPaymentId = Number.parseInt(String(session.metadata?.paymentId || ''), 10) || null;
  const payment =
    (metaPaymentId && (await tx.payment.findUnique({ where: { id: metaPaymentId } }))) ||
    (session.id && (await tx.payment.findUnique({ where: { stripeCheckoutSessionId: session.id } })));

  if (!payment) {
    throw new PaymentWebhookProcessingError(
      'Checkout completion could not resolve a local Payment',
      { code: 'CHECKOUT_PAYMENT_NOT_FOUND' }
    );
  }

  let convergence;
  try {
    convergence = await convergePaymentToSucceeded(tx, payment, {
      source: 'stripe_checkout_webhook',
      actorType: 'system',
      actorId: session.id,
      reason: 'checkout.session.completed received from Stripe',
    });
  } catch (error) {
    if (!(error instanceof PaymentTransitionError)) throw error;
    throw new PaymentWebhookProcessingError(
      `Checkout success cannot transition Payment ${payment.id} from ${payment.status}`,
      { code: 'CHECKOUT_PAYMENT_STATE_CONFLICT', cause: error }
    );
  }

  if (!convergence.wonSucceededTransition) {
    return { outcome: convergence.outcome };
  }

  const succeededPayment = convergence.payment;
  const userId = succeededPayment.userId;
  const planTier = succeededPayment.planTier;
  const beforeUser = await tx.user.findUnique({ where: { id: userId } });
  if (!beforeUser) {
    throw new PaymentWebhookProcessingError(
      `Checkout completion user ${userId} was not found`,
      { code: 'CHECKOUT_USER_NOT_FOUND' }
    );
  }

  await tx.payment.update({
    where: { id: succeededPayment.id },
    data: { externalId: session.subscription },
  });

  if (session.customer && beforeUser.stripeCustomerId !== session.customer) {
    await tx.user.update({ where: { id: userId }, data: { stripeCustomerId: session.customer } });
  }

  const now = new Date();
  const subscription = await upsertLocalSubscription(tx, {
    userId,
    planTier,
    status: 'active',
    externalId: session.subscription,
    currentPeriodStart: now,
    currentPeriodEnd: new Date(now.getTime() + DEFAULT_PERIOD_MS),
  });

  const afterUser = await applyUserEntitlements(tx, { userId, planTier, role: 'premium' });

  await writeAuditLog(tx, {
    action: 'checkout.session.completed',
    entityType: 'subscription',
    entityId: subscription.id,
    before: { planTier: beforeUser.planTier, role: beforeUser.role },
    after: { planTier: afterUser.planTier, role: afterUser.role, subscriptionStatus: subscription.status },
  });

  return { outcome: 'processed' };
}

/** invoice.paid — renewal succeeded: keep the subscription active and extend the period. */
async function handleInvoicePaid(tx, invoice) {
  const subscription = invoice.subscription && (await findLocalSubscriptionByExternalId(tx, invoice.subscription));
  if (!subscription) {
    return { outcome: 'ignored' };
  }

  const beforeUser = await tx.user.findUnique({ where: { id: subscription.userId } });

  const updatedSub = await tx.subscription.update({
    where: { id: subscription.id },
    data: {
      status: 'active',
      currentPeriodStart: toDateFromUnixSeconds(invoice.period_start) || subscription.currentPeriodStart,
      currentPeriodEnd: toDateFromUnixSeconds(invoice.period_end) || subscription.currentPeriodEnd,
    },
  });

  const afterUser = await applyUserEntitlements(tx, {
    userId: subscription.userId,
    planTier: subscription.planTier,
    role: 'premium',
  });

  await writeAuditLog(tx, {
    action: 'invoice.paid',
    entityType: 'subscription',
    entityId: updatedSub.id,
    before: { status: subscription.status, planTier: beforeUser?.planTier, role: beforeUser?.role },
    after: { status: updatedSub.status, planTier: afterUser.planTier, role: afterUser.role },
  });

  return { outcome: 'processed' };
}

/**
 * invoice.payment_failed — mark the subscription past_due. Entitlements are left
 * untouched (grace period); only customer.subscription.deleted downgrades the user.
 */
async function handleInvoicePaymentFailed(tx, invoice) {
  const subscription = invoice.subscription && (await findLocalSubscriptionByExternalId(tx, invoice.subscription));
  if (!subscription) {
    return { outcome: 'ignored' };
  }

  const updatedSub = await tx.subscription.update({
    where: { id: subscription.id },
    data: { status: 'past_due' },
  });

  await writeAuditLog(tx, {
    action: 'invoice.payment_failed',
    entityType: 'subscription',
    entityId: updatedSub.id,
    before: { status: subscription.status },
    after: { status: updatedSub.status },
  });

  return { outcome: 'processed' };
}

/**
 * customer.subscription.updated — sync plan/status/period from Stripe's source of
 * truth. Resolves the owning user via the local Subscription row, falling back to
 * User.stripeCustomerId for the first event seen for a given subscription.
 */
async function handleSubscriptionUpdated(tx, sub) {
  const priceId = sub.items?.data?.[0]?.price?.id || null;
  const planTierFromPrice = resolvePlanTierForPriceId(priceId);
  const mappedStatus = mapStripeSubscriptionStatus(sub.status);

  const localSub = await findLocalSubscriptionByExternalId(tx, sub.id);
  let userId = localSub?.userId || null;

  if (!userId && sub.customer) {
    const user = await tx.user.findUnique({ where: { stripeCustomerId: sub.customer } });
    userId = user?.id || null;
  }

  const planTier = planTierFromPrice || localSub?.planTier || null;

  if (!userId || !planTier) {
    return { outcome: 'ignored' };
  }

  const beforeUser = await tx.user.findUnique({ where: { id: userId } });

  const updatedSub = await upsertLocalSubscription(tx, {
    userId,
    planTier,
    status: mappedStatus,
    externalId: sub.id,
    currentPeriodStart: toDateFromUnixSeconds(sub.current_period_start) || new Date(),
    currentPeriodEnd:
      toDateFromUnixSeconds(sub.current_period_end) || new Date(Date.now() + DEFAULT_PERIOD_MS),
  });

  let afterUser = beforeUser;
  if (mappedStatus === 'active') {
    afterUser = await applyUserEntitlements(tx, { userId, planTier, role: 'premium' });
  } else if (mappedStatus === 'canceled') {
    afterUser = await applyUserEntitlements(tx, { userId, planTier: null, role: 'student' });
  }
  // past_due: leave entitlements untouched (grace period)

  await writeAuditLog(tx, {
    action: 'customer.subscription.updated',
    entityType: 'subscription',
    entityId: updatedSub.id,
    before: { status: localSub?.status, planTier: beforeUser?.planTier, role: beforeUser?.role },
    after: { status: updatedSub.status, planTier: afterUser.planTier, role: afterUser.role },
  });

  return { outcome: 'processed' };
}

/** customer.subscription.deleted — subscription fully canceled: downgrade the user. */
async function handleSubscriptionDeleted(tx, sub) {
  const localSub = await findLocalSubscriptionByExternalId(tx, sub.id);
  if (!localSub) {
    return { outcome: 'ignored' };
  }

  const beforeUser = await tx.user.findUnique({ where: { id: localSub.userId } });

  const updatedSub = await tx.subscription.update({
    where: { id: localSub.id },
    data: { status: 'canceled' },
  });

  const afterUser = await applyUserEntitlements(tx, {
    userId: localSub.userId,
    planTier: null,
    role: 'student',
  });

  await writeAuditLog(tx, {
    action: 'customer.subscription.deleted',
    entityType: 'subscription',
    entityId: updatedSub.id,
    before: { status: localSub.status, planTier: beforeUser?.planTier, role: beforeUser?.role },
    after: { status: updatedSub.status, planTier: afterUser.planTier, role: afterUser.role },
  });

  return { outcome: 'processed' };
}

/**
 * Process one verified Stripe webhook event. Records the event, applies its
 * effect, and writes an audit log entry, all inside a single transaction:
 * a mid-transaction failure rolls back everything, including the PaymentEvent
 * insert, so a retried delivery is not mistaken for a duplicate.
 *
 * Idempotency relies on the `payment_events.stripe_event_id` UNIQUE constraint
 * (caught as P2002) rather than a prior findFirst, to avoid a check-then-insert race.
 */
export async function processStripeWebhookEvent(event, { db = prisma } = {}) {
  const stripeEventId = event?.id;
  const eventType = event?.type;

  if (!stripeEventId || !eventType) {
    throw new PaymentServiceError('Malformed Stripe event', {
      statusCode: 400,
      clientMessage: 'Malformed Stripe event',
    });
  }

  try {
    return await db.$transaction(async (tx) => {
      const paymentEvent = await tx.paymentEvent.create({
        data: {
          type: eventType,
          payload: JSON.stringify(event),
          idempotencyKey: `stripe_sub:${stripeEventId}`,
          stripeEventId,
          outcome: 'processing',
          processedAt: null,
        },
      });

      if (!SUBSCRIPTION_EVENT_TYPES.has(eventType)) {
        await tx.paymentEvent.update({
          where: { id: paymentEvent.id },
          data: { outcome: 'ignored', processedAt: new Date() },
        });
        return { outcome: 'ignored', eventType };
      }

      const object = event.data?.object || {};
      let result;
      switch (eventType) {
        case 'checkout.session.completed':
          result = await handleCheckoutSessionCompleted(tx, object);
          break;
        case 'invoice.paid':
          result = await handleInvoicePaid(tx, object);
          break;
        case 'invoice.payment_failed':
          result = await handleInvoicePaymentFailed(tx, object);
          break;
        case 'customer.subscription.updated':
          result = await handleSubscriptionUpdated(tx, object);
          break;
        case 'customer.subscription.deleted':
          result = await handleSubscriptionDeleted(tx, object);
          break;
        default:
          result = { outcome: 'ignored' };
      }

      await tx.paymentEvent.update({
        where: { id: paymentEvent.id },
        data: { outcome: result.outcome, processedAt: new Date() },
      });

      return { outcome: result.outcome, eventType };
    });
  } catch (error) {
    if (error?.code !== 'P2002') throw error;

    const committedEvent = await db.paymentEvent.findUnique({
      where: { stripeEventId },
    });
    if (committedEvent?.stripeEventId === stripeEventId) {
      return { outcome: 'duplicate', eventType };
    }
    throw error;
  }
}

export async function findPaymentForStripeWebhook({
  stripePaymentIntentId,
  paymentId,
  idempotencyKey,
}) {
  if (stripePaymentIntentId) {
    const byPi = await prisma.payment.findUnique({
      where: { stripePaymentIntentId },
    });
    if (byPi) return byPi;
  }
  if (paymentId) {
    const byId = await prisma.payment.findUnique({
      where: { id: Number(paymentId) },
    });
    if (byId) return byId;
  }
  if (idempotencyKey) {
    return prisma.payment.findUnique({ where: { idempotencyKey } });
  }
  return null;
}

const webhookProcessingError = (message, code, cause) =>
  new PaymentWebhookProcessingError(message, { code, cause });

const parseStripeMetadataPaymentId = (metadata) => {
  if (!Object.prototype.hasOwnProperty.call(metadata || {}, 'paymentId')) {
    return null;
  }

  const normalized = String(metadata.paymentId ?? '').trim();
  if (!/^[1-9]\d*$/.test(normalized)) {
    throw webhookProcessingError(
      'Stripe PaymentIntent metadata.paymentId is malformed',
      'PAYMENT_WEBHOOK_INVALID_METADATA'
    );
  }

  const paymentId = Number(normalized);
  if (!Number.isSafeInteger(paymentId) || paymentId <= 0) {
    throw webhookProcessingError(
      'Stripe PaymentIntent metadata.paymentId is outside the supported integer range',
      'PAYMENT_WEBHOOK_INVALID_METADATA'
    );
  }
  return paymentId;
};

const resolvePaymentIntentWebhookPayment = async (tx, paymentIntent) => {
  const stripePaymentIntentId =
    typeof paymentIntent?.id === 'string' ? paymentIntent.id.trim() : '';
  if (!stripePaymentIntentId) {
    throw webhookProcessingError(
      'Stripe PaymentIntent event is missing a PaymentIntent id',
      'PAYMENT_WEBHOOK_INVALID_PAYMENT_INTENT'
    );
  }

  const metadataPaymentId = parseStripeMetadataPaymentId(
    paymentIntent?.metadata || {}
  );
  const byStripePaymentIntentId = await tx.payment.findUnique({
    where: { stripePaymentIntentId },
  });
  const byMetadataPaymentId = metadataPaymentId
    ? await tx.payment.findUnique({ where: { id: metadataPaymentId } })
    : null;

  if (
    byStripePaymentIntentId &&
    byMetadataPaymentId &&
    byStripePaymentIntentId.id !== byMetadataPaymentId.id
  ) {
    throw webhookProcessingError(
      'Stripe PaymentIntent id and metadata.paymentId resolve to different payments',
      'PAYMENT_WEBHOOK_IDENTITY_CONFLICT'
    );
  }

  const payment = byStripePaymentIntentId || byMetadataPaymentId;
  if (!payment) {
    throw webhookProcessingError(
      'No local Payment matches the Stripe PaymentIntent event',
      'PAYMENT_WEBHOOK_PAYMENT_NOT_FOUND'
    );
  }
  return { payment, stripePaymentIntentId };
};

const attachStripePaymentIntentIdentity = async (
  tx,
  payment,
  stripePaymentIntentId
) => {
  if (
    payment.stripePaymentIntentId &&
    payment.stripePaymentIntentId !== stripePaymentIntentId
  ) {
    throw new PaymentIntentConflictError();
  }
  if (payment.stripePaymentIntentId === stripePaymentIntentId) return payment;

  const attachment = await tx.payment.updateMany({
    where: { id: payment.id, stripePaymentIntentId: null },
    data: {
      stripePaymentIntentId,
      externalId: stripePaymentIntentId,
    },
  });
  const attachedPayment = await tx.payment.findUnique({
    where: { id: payment.id },
  });
  if (!attachedPayment) throw new PaymentNotFoundError();
  if (
    attachment.count !== 1 &&
    attachedPayment.stripePaymentIntentId !== stripePaymentIntentId
  ) {
    throw new PaymentIntentConflictError();
  }
  return attachedPayment;
};

/**
 * Apply the existing one-time-payment entitlement side effects. The caller
 * must already have won the canonical processing -> succeeded transition.
 */
export async function activateOneTimePaymentEntitlement(
  tx,
  { payment, stripePaymentIntentId }
) {
  const now = new Date();
  const periodEnd = new Date(now.getTime() + DEFAULT_PERIOD_MS);
  const subscriptionExternalId =
    stripePaymentIntentId ||
    payment.externalId ||
    payment.stripePaymentIntentId ||
    `payment_${payment.id}`;
  const provider = payment.provider || 'stripe';
  const existingSubscription = await tx.subscription.findUnique({
    where: {
      provider_externalId: { provider, externalId: subscriptionExternalId },
    },
  });

  if (
    existingSubscription &&
    existingSubscription.userId !== payment.userId
  ) {
    throw webhookProcessingError(
      'The Stripe PaymentIntent is already attached to another user subscription',
      'PAYMENT_WEBHOOK_SUBSCRIPTION_CONFLICT'
    );
  }

  const subscription = existingSubscription
    ? await tx.subscription.update({
        where: { id: existingSubscription.id },
        data: {
          planTier: payment.planTier,
          status: 'active',
          currentPeriodStart: now,
          currentPeriodEnd: periodEnd,
        },
      })
    : await tx.subscription.create({
        data: {
          userId: payment.userId,
          planTier: payment.planTier,
          status: 'active',
          provider,
          externalId: subscriptionExternalId,
          currentPeriodStart: now,
          currentPeriodEnd: periodEnd,
        },
      });
  const user = await applyUserEntitlements(tx, {
    userId: payment.userId,
    planTier: payment.planTier,
    role: 'premium',
  });
  return { subscription, user };
}

const paymentIntentTransitionDecision = (eventType, status) => {
  if (status === PAYMENT_STATUSES.CREATED) {
    return { targetStatus: PAYMENT_STATUSES.PENDING };
  }

  switch (eventType) {
    case 'payment_intent.processing':
      if (status === PAYMENT_STATUSES.PENDING) {
        return { targetStatus: PAYMENT_STATUSES.PROCESSING };
      }
      if (status === PAYMENT_STATUSES.PROCESSING) {
        return { outcome: 'processed' };
      }
      if (
        status === PAYMENT_STATUSES.SUCCEEDED ||
        status === PAYMENT_STATUSES.FAILED ||
        status === PAYMENT_STATUSES.CANCELED
      ) {
        return { outcome: 'ignored_terminal' };
      }
      break;

    case 'payment_intent.succeeded':
      if (status === PAYMENT_STATUSES.PENDING) {
        return { targetStatus: PAYMENT_STATUSES.PROCESSING };
      }
      if (status === PAYMENT_STATUSES.PROCESSING) {
        return { targetStatus: PAYMENT_STATUSES.SUCCEEDED };
      }
      if (status === PAYMENT_STATUSES.SUCCEEDED) {
        return { outcome: 'already_succeeded' };
      }
      if (
        status === PAYMENT_STATUSES.FAILED ||
        status === PAYMENT_STATUSES.CANCELED
      ) {
        throw webhookProcessingError(
          `A ${status} Payment cannot be resurrected by a success webhook`,
          'PAYMENT_WEBHOOK_TERMINAL_CONFLICT'
        );
      }
      break;

    case 'payment_intent.payment_failed':
      if (
        status === PAYMENT_STATUSES.PENDING ||
        status === PAYMENT_STATUSES.PROCESSING
      ) {
        return { targetStatus: PAYMENT_STATUSES.FAILED };
      }
      if (status === PAYMENT_STATUSES.FAILED) {
        return { outcome: 'processed' };
      }
      if (
        status === PAYMENT_STATUSES.SUCCEEDED ||
        status === PAYMENT_STATUSES.CANCELED
      ) {
        return { outcome: 'ignored_terminal' };
      }
      break;

    case 'payment_intent.canceled':
      if (
        status === PAYMENT_STATUSES.PENDING ||
        status === PAYMENT_STATUSES.PROCESSING
      ) {
        return { targetStatus: PAYMENT_STATUSES.CANCELED };
      }
      if (status === PAYMENT_STATUSES.CANCELED) {
        return { outcome: 'processed' };
      }
      if (
        status === PAYMENT_STATUSES.SUCCEEDED ||
        status === PAYMENT_STATUSES.FAILED
      ) {
        return { outcome: 'ignored_terminal' };
      }
      break;

    default:
      break;
  }

  throw webhookProcessingError(
    `Cannot converge ${eventType} from local Payment status ${status}`,
    'PAYMENT_WEBHOOK_STATE_CONFLICT'
  );
};

const convergePaymentIntentWebhook = async (
  tx,
  { payment, eventType, stripeEventId, stripePaymentIntentId, entitlementWriter }
) => {
  let current = payment;
  let wonSucceededTransition = false;

  // A created success needs three legal edges plus one final observation. Each
  // CAS result is explicitly re-evaluated against the returned current state.
  for (let step = 0; step < 5; step += 1) {
    const decision = paymentIntentTransitionDecision(eventType, current.status);
    if (!decision.targetStatus) {
      return {
        payment: current,
        outcome: wonSucceededTransition ? 'processed' : decision.outcome,
        entitlementActivated: wonSucceededTransition,
      };
    }

    const transition = await applyTransition(
      tx,
      current.id,
      decision.targetStatus,
      {
        source: 'stripe_webhook',
        actorType: 'system',
        actorId: stripeEventId,
        reason: `${eventType} received from Stripe`,
      }
    );
    current = transition.payment;

    const wonThisSucceededTransition =
      transition.applied === true &&
      transition.previousStatus === PAYMENT_STATUSES.PROCESSING &&
      transition.targetStatus === PAYMENT_STATUSES.SUCCEEDED;
    if (wonThisSucceededTransition) {
      await entitlementWriter(tx, {
        payment: transition.payment,
        stripePaymentIntentId,
      });
      wonSucceededTransition = true;
    }

    switch (transition.outcome) {
      case 'applied':
      case 'already_at_target':
      case 'state_changed':
        // Re-evaluate the observed state and select its next legal edge.
        break;
      default:
        throw webhookProcessingError(
          `Unexpected payment transition outcome: ${transition.outcome}`,
          'PAYMENT_WEBHOOK_TRANSITION_ERROR'
        );
    }
  }

  throw webhookProcessingError(
    `Payment ${payment.id} did not converge for ${eventType}`,
    'PAYMENT_WEBHOOK_CONVERGENCE_FAILED'
  );
};

/**
 * Atomically process one one-time Stripe PaymentIntent webhook delivery.
 * Duplicate P2002 handling intentionally occurs outside the failed transaction.
 */
export async function processPaymentIntentWebhookEvent({
  event,
  db = prisma,
  entitlementWriter = activateOneTimePaymentEntitlement,
} = {}) {
  const stripeEventId = event?.id;
  const eventType = event?.type || 'stripe.unknown';

  if (typeof stripeEventId !== 'string' || !stripeEventId.trim()) {
    throw webhookProcessingError(
      'Stripe webhook event is missing an id',
      'PAYMENT_WEBHOOK_INVALID_EVENT'
    );
  }
  if (typeof entitlementWriter !== 'function') {
    throw new TypeError('entitlementWriter must be a function');
  }

  try {
    return await db.$transaction(async (tx) => {
      // This unique insert is the first domain write and the delivery claim.
      // P2002 must escape because PostgreSQL aborts the transaction.
      const paymentEvent = await tx.paymentEvent.create({
        data: {
          type: eventType,
          payload: JSON.stringify(event),
          idempotencyKey: `stripe:${stripeEventId}`,
          stripeEventId,
          outcome: 'processing',
          processedAt: null,
        },
      });

      if (!PAYMENT_INTENT_EVENT_TYPES.has(eventType)) {
        await tx.paymentEvent.update({
          where: { id: paymentEvent.id },
          data: { outcome: 'ignored', processedAt: new Date() },
        });
        return { outcome: 'ignored', eventType, paymentId: null };
      }

      const resolved = await resolvePaymentIntentWebhookPayment(
        tx,
        event?.data?.object
      );
      const payment = await attachStripePaymentIntentIdentity(
        tx,
        resolved.payment,
        resolved.stripePaymentIntentId
      );
      const result = await convergePaymentIntentWebhook(tx, {
        payment,
        eventType,
        stripeEventId,
        stripePaymentIntentId: resolved.stripePaymentIntentId,
        entitlementWriter,
      });

      await tx.paymentEvent.update({
        where: { id: paymentEvent.id },
        data: {
          paymentId: result.payment.id,
          outcome: result.outcome,
          processedAt: new Date(),
        },
      });
      return {
        outcome: result.outcome,
        eventType,
        paymentId: result.payment.id,
        entitlementActivated: result.entitlementActivated,
      };
    });
  } catch (error) {
    if (error?.code !== 'P2002') throw error;

    // The failed transaction is over; use a fresh client and only recognize
    // the exact committed Stripe delivery as a duplicate.
    const committedEvent = await db.paymentEvent.findUnique({
      where: { stripeEventId },
    });
    if (committedEvent?.stripeEventId === stripeEventId) {
      return {
        outcome: 'duplicate',
        eventType,
        paymentId: committedEvent.paymentId,
        entitlementActivated: false,
      };
    }
    throw error;
  }
}

export async function createSimulatedPayment({
  userId,
  planTier,
  idempotencyKey,
}, { db = prisma } = {}) {
  const normalizedPlan = assertPaidPlan(planTier);
  const amount = PLAN_AMOUNTS[normalizedPlan] ?? 0;

  return db.$transaction((tx) =>
    createPaymentInPendingState(
      tx,
      {
        userId,
        planTier: normalizedPlan,
        amount,
        currency: 'usd',
        provider: 'simulated',
        idempotencyKey,
      },
      paymentInitializationMeta({
        source: 'simulated_payment_api',
        actorType: 'user',
        actorId: userId,
        reason: 'simulated payment initialized',
      })
    )
  );
}

const activateSimulatedPaymentEntitlement = async (tx, { payment }) => {
  const currentUser = await tx.user.findUnique({ where: { id: payment.userId } });
  if (!currentUser) throw new Error('user_not_found');

  return setUserPlanTier(
    {
      userId: payment.userId,
      planTier: payment.planTier,
      extraData: { role: currentUser.role === 'admin' ? 'admin' : 'premium' },
      reason: 'payment_simulated',
      actor: 'simulator',
    },
    tx
  );
};

const simulatedConfirmationTarget = (status) => {
  switch (status) {
    case PAYMENT_STATUSES.CREATED:
      return PAYMENT_STATUSES.PENDING;
    case PAYMENT_STATUSES.PENDING:
      return PAYMENT_STATUSES.PROCESSING;
    case PAYMENT_STATUSES.PROCESSING:
      return PAYMENT_STATUSES.SUCCEEDED;
    default:
      return null;
  }
};

export async function confirmSimulatedPayment(
  { paymentId, actorId },
  {
    db = prisma,
    entitlementWriter = activateSimulatedPaymentEntitlement,
    transitionPayment = applyTransition,
  } = {}
) {
  return db.$transaction(async (tx) => {
    let current = await tx.payment.findUnique({ where: { id: paymentId } });
    if (!current) throw new PaymentNotFoundError();

    for (let step = 0; step < 3; step += 1) {
      const targetStatus = simulatedConfirmationTarget(current.status);
      if (!targetStatus) {
        throw new PaymentConfirmationConflictError(current.status);
      }

      const transition = await transitionPayment(tx, current.id, targetStatus, {
        source: 'simulated_admin_confirmation',
        actorType: 'admin',
        actorId,
        reason: 'administrator confirmed simulated payment',
      });
      current = transition.payment;

      const wonSucceededTransition =
        transition.applied === true &&
        transition.previousStatus === PAYMENT_STATUSES.PROCESSING &&
        transition.targetStatus === PAYMENT_STATUSES.SUCCEEDED;
      if (wonSucceededTransition) {
        await entitlementWriter(tx, { payment: current, actorId });
        return current;
      }

      if (current.status === PAYMENT_STATUSES.SUCCEEDED) {
        throw new PaymentConfirmationConflictError(current.status);
      }
    }

    throw new PaymentConfirmationConflictError(current.status);
  });
}

/** @deprecated Prefer markPaymentCompleted — kept for callers expecting status "processed". */
export async function markPaymentProcessed({ paymentId }) {
  const result = await markPaymentCompleted({ paymentId });
  return result.payment;
}

const ONE_TIME_PAYMENT_CURRENCY = 'usd';
const ONE_TIME_PAYMENT_PROVIDER = 'stripe';
const RECOGNIZED_STRIPE_PAYMENT_INTENT_STATUSES = new Set([
  'requires_payment_method',
  'requires_confirmation',
  'requires_action',
  'processing',
  'requires_capture',
  'succeeded',
  'canceled',
]);
const NON_RETRYABLE_STRIPE_ERROR_STATUSES = new Set([
  'requires_payment_method',
  'canceled',
]);
const NON_RETRIABLE_PAYMENT_STATUSES = new Set([
  PAYMENT_STATUSES.SUCCEEDED,
  PAYMENT_STATUSES.FAILED,
  PAYMENT_STATUSES.CANCELED,
  // Read-only compatibility until the status data migration runs.
  'completed',
  'processed',
]);

const assertIdempotentPaymentMatches = (
  payment,
  { userId, planTier, amount, currency, provider, paymentMethodId }
) => {
  const matches =
    payment.userId === userId &&
    payment.planTier === planTier &&
    Number(payment.amount) === amount &&
    payment.currency === currency &&
    payment.provider === provider &&
    (payment.paymentMethodId ?? null) === (paymentMethodId ?? null);

  if (!matches) throw new PaymentIdempotencyConflictError();
  return payment;
};

const isIdempotencyKeyUniqueViolation = (error) => {
  if (error?.code !== 'P2002') return false;

  const rawTarget = error?.meta?.target;
  const targets = Array.isArray(rawTarget) ? rawTarget : [rawTarget];
  return targets.some((target) => {
    const normalized = String(target || '').toLowerCase();
    return (
      normalized.includes('idempotencykey') ||
      normalized.includes('idempotency_key')
    );
  });
};

const transitionCreatedPaymentToPending = async (tx, payment, userId) => {
  if (payment.status !== PAYMENT_STATUSES.CREATED) return payment;

  const transition = await applyTransition(
    tx,
    payment.id,
    PAYMENT_STATUSES.PENDING,
    paymentInitializationMeta({
      source: 'payment_api',
      actorType: 'user',
      actorId: userId,
      reason: 'payment initialized',
    })
  );
  return transition.payment;
};

const createOrLoadCommittedPayment = async ({ db, request }) => {
  try {
    return await db.$transaction(async (tx) => {
      const existing = await tx.payment.findUnique({
        where: { idempotencyKey: request.idempotencyKey },
      });

      if (existing) {
        assertIdempotentPaymentMatches(existing, request);
        return transitionCreatedPaymentToPending(tx, existing, request.userId);
      }

      return createPaymentInPendingState(
        tx,
        {
          userId: request.userId,
          amount: request.amount,
          currency: request.currency,
          planTier: request.planTier,
          provider: request.provider,
          paymentMethodId: request.paymentMethodId,
          idempotencyKey: request.idempotencyKey,
          metadata: serializeMetadata({ source: 'payment_method' }),
        },
        paymentInitializationMeta({
          source: 'payment_api',
          actorType: 'user',
          actorId: request.userId,
          reason: 'payment initialized',
        })
      );
    });
  } catch (error) {
    if (!isIdempotencyKeyUniqueViolation(error)) throw error;

    // The failed transaction has rolled back. Re-query through the normal
    // Prisma client rather than attempting to continue with its aborted tx.
    const raced = await db.payment.findUnique({
      where: { idempotencyKey: request.idempotencyKey },
    });
    if (!raced) throw error;

    return assertIdempotentPaymentMatches(raced, request);
  }
};

const nextTransitionForStripeStatus = (localStatus, stripeStatus) => {
  if (localStatus === PAYMENT_STATUSES.PENDING) {
    switch (stripeStatus) {
      case 'processing':
      case 'requires_capture':
      case 'succeeded':
        return PAYMENT_STATUSES.PROCESSING;
      case 'requires_payment_method':
        return PAYMENT_STATUSES.FAILED;
      case 'canceled':
        return PAYMENT_STATUSES.CANCELED;
      default:
        return null;
    }
  }

  if (localStatus === PAYMENT_STATUSES.PROCESSING) {
    if (stripeStatus === 'requires_payment_method') {
      return PAYMENT_STATUSES.FAILED;
    }
    if (stripeStatus === 'canceled') {
      return PAYMENT_STATUSES.CANCELED;
    }
  }

  return null;
};

const hasStripePaymentIntentId = (stripeIntent) =>
  typeof stripeIntent?.id === 'string' && stripeIntent.id.trim().length > 0;

const hasAuthoritativeStripePaymentIntentStatus = (stripeIntent) =>
  hasStripePaymentIntentId(stripeIntent) &&
  typeof stripeIntent?.status === 'string' &&
  RECOGNIZED_STRIPE_PAYMENT_INTENT_STATUSES.has(stripeIntent.status);

const convergePaymentIntentStatus = async (tx, payment, stripeStatus) => {
  let current = payment;

  // A CAS miss is re-evaluated against the newly observed state. At most two
  // forward machine edges are relevant to any PaymentIntent response here.
  for (let attempt = 0; attempt < 2; attempt += 1) {
    const nextStatus = nextTransitionForStripeStatus(current.status, stripeStatus);
    if (!nextStatus) return current;

    const transition = await applyTransition(tx, current.id, nextStatus, {
      source: 'payment_api',
      actorType: 'user',
      actorId: current.userId,
      reason: `Stripe PaymentIntent status: ${stripeStatus}`,
    });
    current = transition.payment;

    if (transition.outcome !== 'state_changed') return current;
  }

  return current;
};

const attachPaymentIntentAndConverge = async ({ db, paymentId, stripeIntent }) =>
  db.$transaction(async (tx) => {
    let payment = await tx.payment.findUnique({ where: { id: paymentId } });
    if (!payment) throw new PaymentNotFoundError();
    payment = await attachStripePaymentIntentIdentity(
      tx,
      payment,
      stripeIntent.id
    );

    if (!hasAuthoritativeStripePaymentIntentStatus(stripeIntent)) {
      return payment;
    }

    return convergePaymentIntentStatus(tx, payment, stripeIntent.status);
  });

const paymentIntentFromStripeError = (error) =>
  error?.error?.payment_intent || error?.payment_intent || null;

export async function createOrReusePayment({
  userId,
  paymentMethodId,
  planTier,
  idempotencyKey,
}, { db = prisma, requestStripe } = {}) {
  if (!idempotencyKey) throw new Error('idempotencyKey required');

  const normalizedPlan = assertPaidPlan(planTier);
  const amount = PLAN_AMOUNTS[normalizedPlan] ?? 0;
  const request = {
    userId,
    paymentMethodId,
    planTier: normalizedPlan,
    amount,
    currency: ONE_TIME_PAYMENT_CURRENCY,
    provider: ONE_TIME_PAYMENT_PROVIDER,
    idempotencyKey,
  };

  // Transaction A has fully committed before this await resolves. No Stripe
  // request is reachable from createOrLoadCommittedPayment.
  const payment = await createOrLoadCommittedPayment({ db, request });

  if (payment.stripePaymentIntentId) return payment;
  if (NON_RETRIABLE_PAYMENT_STATUSES.has(payment.status)) return payment;

  const body = {
    amount: String(amount),
    currency: ONE_TIME_PAYMENT_CURRENCY,
    payment_method: paymentMethodId,
    confirm: 'true',
    'metadata[paymentId]': String(payment.id),
    'metadata[idempotencyKey]': idempotencyKey,
  };

  let stripeIntent;
  let stripeError = null;
  try {
    if (!requestStripe && !getStripeSecret() && process.env.NODE_ENV === 'test') {
      stripeIntent = {
        id: `test_pi_${payment.id}_${Date.now()}`,
        status: 'requires_confirmation',
      };
    } else {
      stripeIntent = await (requestStripe || stripeRequest)({
        path: '/v1/payment_intents',
        body,
        idempotencyKey,
      });
    }
  } catch (error) {
    stripeError = error;
    stripeIntent = paymentIntentFromStripeError(error);
  }

  if (!hasStripePaymentIntentId(stripeIntent)) {
    throw new StripePaymentRequestError(stripeError || stripeIntent);
  }

  // Transaction B attaches the Stripe identity with a null-only CAS and then
  // advances only through canonical state-machine edges.
  const updated = await attachPaymentIntentAndConverge({
    db,
    paymentId: payment.id,
    stripeIntent,
  });

  console.info(
    {
      userId,
      paymentId: updated.id,
      stripePaymentIntentId: stripeIntent.id,
      idempotencyKey,
      stripeStatus: stripeIntent.status || null,
      outcome: updated.status,
      timestamp: new Date().toISOString(),
    },
    'Stripe payment intent created'
  );

  if (!hasAuthoritativeStripePaymentIntentStatus(stripeIntent)) {
    throw new StripePaymentRequestError(stripeError || stripeIntent);
  }
  if (stripeError) {
    if (NON_RETRYABLE_STRIPE_ERROR_STATUSES.has(stripeIntent.status)) {
      throw new StripePaymentIntentError(stripeError);
    }
    throw new StripePaymentRequestError(stripeError);
  }
  return updated;
}

/**
 * Create a Stripe Checkout Session for the given plan and persist a pending Payment.
 * @returns {{ checkoutUrl: string, sessionId: string, payment: object }}
 */
export async function createCheckoutSession(
  { userId, plan },
  {
    db = prisma,
    requestCheckout = stripeRequest,
    transitionPayment = applyTransition,
  } = {}
) {
  const normalizedPlan = assertPaidPlan(plan);
  const priceId = resolvePriceId(normalizedPlan);
  if (!priceId) {
    throw new PaymentServiceError(
      `Missing Stripe price configuration for plan "${normalizedPlan}"`,
      {
        statusCode: 400,
        clientMessage: `No Stripe price configured for plan "${normalizedPlan}". Set ${PRICE_ENV_BY_PLAN[normalizedPlan] || 'STRIPE_PRICE_*'}.`,
      }
    );
  }

  const successUrl = process.env.STRIPE_CHECKOUT_SUCCESS_URL;
  const cancelUrl = process.env.STRIPE_CHECKOUT_CANCEL_URL;
  if (!successUrl || !cancelUrl) {
    throw new PaymentServiceError(
      'Missing Stripe checkout success/cancel URLs',
      {
        statusCode: 400,
        clientMessage:
          'Checkout URLs are not configured. Set STRIPE_CHECKOUT_SUCCESS_URL and STRIPE_CHECKOUT_CANCEL_URL.',
      }
    );
  }

  const amount = PLAN_AMOUNTS[normalizedPlan] ?? 0;
  const idempotencyKey = `checkout_${userId}_${normalizedPlan}_${crypto.randomUUID()}`;
  const stripeSecret = getStripeSecret();

  const payment = await createPaymentIntent(
    {
      userId,
      planTier: normalizedPlan,
      amount,
      currency: 'usd',
      provider: 'stripe',
      idempotencyKey,
      metadata: { source: 'checkout' },
    },
    { db }
  );

  try {
    if (!stripeSecret && process.env.NODE_ENV === 'test') {
      const sessionId = `cs_test_${payment.id}_${Date.now()}`;
      const checkoutUrl = `https://checkout.stripe.com/c/pay/${sessionId}`;
      const updated = await db.payment.update({
        where: { id: payment.id },
        data: {
          stripeCheckoutSessionId: sessionId,
          externalId: sessionId,
        },
      });
      return { checkoutUrl, sessionId, payment: updated };
    }

    if (process.env.NODE_ENV === 'test' && stripeSecret === 'sk_test_force_error') {
      throw new StripeHttpResponseError(500, {
        error: { type: 'api_error', message: 'Simulated Stripe API failure' },
      });
    }

    const body = {
      mode: 'subscription',
      success_url: successUrl,
      cancel_url: cancelUrl,
      client_reference_id: String(userId),
      'line_items[0][price]': priceId,
      'line_items[0][quantity]': '1',
      'metadata[paymentId]': String(payment.id),
      'metadata[planTier]': normalizedPlan,
    };

    const session = await requestCheckout({
      path: '/v1/checkout/sessions',
      body,
      idempotencyKey,
    });
    if (
      typeof session?.id !== 'string' ||
      !session.id.trim() ||
      typeof session?.url !== 'string' ||
      !session.url.trim()
    ) {
      throw new StripeUnusableResponseError(200, session);
    }

    const updated = await db.payment.update({
      where: { id: payment.id },
      data: {
        stripeCheckoutSessionId: session.id,
        externalId: session.id,
      },
    });

    console.info(
      {
        userId,
        paymentId: updated.id,
        stripeCheckoutSessionId: session.id,
        plan: normalizedPlan,
        outcome: 'checkout_session_created',
        timestamp: new Date().toISOString(),
      },
      'Stripe checkout session created'
    );

    return {
      checkoutUrl: session.url,
      sessionId: session.id,
      payment: updated,
    };
  } catch (err) {
    if (err instanceof PaymentServiceError) throw err;

    console.error(
      {
        paymentId: payment.id,
        userId,
        plan: normalizedPlan,
        stripeError: err?.stripeError || err,
        timestamp: new Date().toISOString(),
      },
      'Stripe checkout session failed'
    );

    const authoritativeFailure = err?.authoritativeFailure === true;
    if (authoritativeFailure) {
      await transitionPayment(db, payment.id, PAYMENT_STATUSES.FAILED, {
        source: 'stripe_checkout_api',
        actorType: 'system',
        actorId: payment.id,
        reason: `Stripe rejected Checkout Session creation with HTTP ${err.httpStatus}`,
      });
    }

    throw new StripeCheckoutRequestError(err, {
      retryable: !authoritativeFailure,
    });
  }
}

export default {
  createPaymentIntent,
  createSimulatedPayment,
  confirmSimulatedPayment,
  markPaymentCompleted,
  recordPaymentEvent,
  ensurePaymentEvent,
  updatePaymentEventOutcome,
  findPaymentForStripeWebhook,
  createOrReusePayment,
  createCheckoutSession,
  markPaymentProcessed,
  getStripeClient,
  constructStripeEvent,
  processStripeWebhookEvent,
  processPaymentIntentWebhookEvent,
  activateOneTimePaymentEntitlement,
  PaymentServiceError,
  InvalidPlanError,
  PaymentNotFoundError,
  PaymentIdempotencyConflictError,
  PaymentIntentConflictError,
  PaymentConfirmationConflictError,
  PaymentWebhookProcessingError,
  StripePaymentRequestError,
  StripePaymentIntentError,
  StripeCheckoutRequestError,
};
